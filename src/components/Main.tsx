import { useState, useSyncExternalStore, use, useEffect } from "react";
import localForage from "localforage";
import {
  Effect,
  Layer,
  ManagedRuntime,
  pipe,
  Ref,
  Stream,
  SubscriptionRef,
  Data,
  Schedule,
  Console,
  Fiber,
  Sink,
  Option,
} from "effect";

const CRAWL_DISALLOW = [
  /^\./, // starts with dot
];

async function crawlDirectoryHandle({
  directoryHandle,
  previousFiles,
  precedingPaths,
  signal,
}: {
  directoryHandle: FileSystemDirectoryHandle;
  previousFiles: FileTree;
  precedingPaths?: string;
  signal?: AbortSignal;
}): Promise<FileTree> {
  let tree: FileTree = {};

  for await (let handle of directoryHandle.values()) {
    if (signal?.aborted) {
      console.warn("ABORTING FILE SEARCH");
      break;
    }

    if (CRAWL_DISALLOW.some((disallowed) => handle.name.match(disallowed))) {
      continue;
    }

    const path = [precedingPaths, handle.name].filter(Boolean).join("/");

    // maintain stable reference
    handle = (await previousFiles[path]?.isSameEntry(handle)) ? previousFiles[path] : handle;

    if (handle.kind === "file") {
      tree = { ...tree, [path]: handle };
    } else {
      const partialTree = await crawlDirectoryHandle({
        directoryHandle: handle,
        previousFiles,
        precedingPaths: path,
      });
      tree = { ...tree, ...partialTree };
    }
  }

  return tree;
}

type State = Data.TaggedEnum<{
  Ejected: {};
  Selecting: {};
  Selected: { readonly directory: FileSystemDirectoryHandle; files: FileTree };
}>;

const State = Data.taggedEnum<State>();

const makeMainActor = () =>
  Effect.gen(function* () {
    const restored = yield* Effect.promise(async () => {
      await localForage.setDriver(localForage.INDEXEDDB);
      const directory = await localForage.getItem<FileSystemDirectoryHandle>("directory");
      // TODO: see if we can make a good UX with ultra qukck loading
      await new Promise((res) => setTimeout(res, 500));
      return directory;
    });

    const ref = yield* SubscriptionRef.make<State>(
      restored ? State.Selected({ directory: restored, files: {} }) : State.Ejected(),
    );

    const eject = () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => localForage.removeItem("directory"));
        yield* Ref.set(ref, State.Ejected());
      });

    const showDirectoryPicker = () =>
      Effect.gen(function* () {
        yield* Ref.set(ref, State.Selecting());

        const handle = yield* pipe(
          Effect.tryPromise({ try: () => window.showDirectoryPicker(), catch: Effect.fail }),
          Effect.catchAll(eject),
        );

        if (!handle) {
          return;
        }

        yield* Effect.promise(() => localForage.setItem("directory", handle));
        yield* Ref.set(ref, State.Selected({ directory: handle, files: {} }));
      });

    const changes = ref.changes.pipe(
      Stream.changes,
      Stream.flatMap((state) => {
        if (State.$is("Selected")(state)) {
          return Stream.mergeAll(
            [Stream.void, Stream.fromEventListener(document, "mouseenter"), Stream.fromEventListener(window, "focus")],
            { concurrency: "unbounded" },
          ).pipe(
            Stream.mapEffect(() => {
              return pipe(
                Effect.promise((signal) => {
                  console.log("recrawl");
                  return crawlDirectoryHandle({ directoryHandle: state.directory, previousFiles: {}, signal });
                }),
                Effect.map((files): State => State.Selected({ ...state, files })),
              );
            }),
          );
        }
        return Stream.make(state);
      }),
    );

    return {
      changes,
      get: Stream.runHead(changes),
      showDirectoryPicker,
      eject,
    };
  });

type FileTree = Record<string, FileSystemFileHandle>;

const runtime = ManagedRuntime.make(Layer.empty);

const storePromise = runtime.runPromise(makeMainActor()).then(async (actor) => {
  let snapshot = Option.getOrThrow(await runtime.runPromise(actor.get));

  return {
    actor,
    subscribe(callback: () => void) {
      return Stream.runForEach(actor.changes, (value) => {
        snapshot = value;
        return Effect.sync(callback);
      }).pipe(runtime.runCallback);
    },
    getSnapshot() {
      return snapshot;
    },
  };
});

export function useMainActor() {
  const { actor, subscribe, getSnapshot } = use(storePromise);

  const value = useSyncExternalStore(subscribe, getSnapshot);

  return [value, actor] as const;
}

// https://discord.com/channels/795981131316985866/1151827019684905000/1260929530797887579
// export function useStream<T>(stream: SubscriptionRef.SubscriptionRef<T>) {
//   return useSyncExternalStore(
//     (callback) => Stream.runForEach(stream, () => Effect.sync(callback)).pipe(runtime.runCallback),
//     () => runtime.runSync(Stream.take),
//   );
// }

export function Main() {
  const [state, actor] = useMainActor();

  return (
    <div className="flex gap-4 flex-col">
      <div className="flex gap-4">
        <button onClick={() => runtime.runPromise(actor.showDirectoryPicker())}>open</button>
        <button onClick={() => runtime.runPromise(actor.eject())}>reset</button>
      </div>
      <p className="block">
        {state._tag} : {State.$is("Selected")(state) && state.directory.name}
      </p>
      {State.$is("Selected")(state) && (
        <ul>
          {Object.entries(state.files)?.map(([path, file]) => {
            return <li key={path}>{path}</li>;
          })}
        </ul>
      )}
    </div>
  );
}
