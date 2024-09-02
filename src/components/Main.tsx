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
  Console,
  Option,
  Exit,
  Duration,
} from "effect";
import { ErrorBoundary } from "react-error-boundary";

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
  Selected: { readonly directory: FileSystemDirectoryHandle; files: Stream.Stream<FileTree> };
}>;

const State = Data.taggedEnum<State>();

const makeFilesStream = (handle: FileSystemDirectoryHandle) =>
  pipe(
    Stream.mergeAll(
      [
        // void needed to trigger initial
        Stream.void,
        Stream.fromEventListener(document, "mouseenter"),
        Stream.fromEventListener(window, "focus"),
      ],
      { concurrency: "unbounded" },
    ),
    Stream.flatMap(() => {
      return Effect.promise((signal) => {
        console.log("begin crawl");
        // TODO: handle previous files (ideally via stream)
        return crawlDirectoryHandle({ directoryHandle: handle, previousFiles: {}, signal });
      });
    }),
  );

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
      restored ? State.Selected({ directory: restored, files: makeFilesStream(restored) }) : State.Ejected(),
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
        yield* Ref.set(
          ref,
          State.Selected({
            directory: handle,
            files: makeFilesStream(handle),
          }),
        );
      });

    const changes = ref.changes;

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

function Files({ state }: { state: State }) {
  // TODO: make this use sync external store + suspense
  const [fileTree, setFileTree] = useState({});
  const [fileError, setFileError] = useState<Error | null>(null);
  useEffect(() => {
    if (State.$is("Selected")(state)) {
      return state.files.pipe(
        Stream.runForEach((result) => Effect.sync(() => setFileTree(result))),
        (s) =>
          runtime.runCallback(s, {
            onExit(exit) {
              Exit.isFailure(exit) ? setFileError(new Error("something is wrong with reading files")) : null;
            },
          }),
      );
    }
  }, [state]);
  if (fileError) {
    throw fileError;
  }
  return (
    <div>
      {State.$is("Selected")(state) && (
        <ul>
          {Object.entries(fileTree)?.map(([path, file]) => {
            return <li key={path}>{path}</li>;
          })}
        </ul>
      )}
    </div>
  );
}

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
      <ErrorBoundary fallback={<div>something is wrong with files</div>}>
        <Files state={state} />
      </ErrorBoundary>
    </div>
  );
}
