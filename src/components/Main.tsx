import { useState, useSyncExternalStore, use } from "react";
import localForage from "localforage";
import { assign, fromPromise, setup, stopChild, type ActorRef, type ActorRefFrom, type AnyActorRef } from "xstate";
import { Effect, Layer, ManagedRuntime, pipe, Ref, Stream, SubscriptionRef, Data } from "effect";

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

const treeCrawler = fromPromise<void, { directoryHandle: FileSystemDirectoryHandle; parent: AnyActorRef }>(
  async ({ signal, input: { directoryHandle, parent } }) => {
    const result = await crawlDirectoryHandle({
      signal,
      directoryHandle,
      previousFiles: {},
    });

    if (!signal.aborted) {
      parent.send({ type: "REFRESH_COMPLETE", files: result });
    }
  },
);

type State = Data.TaggedEnum<{
  Ejected: {};
  Selecting: {};
  Selected: { readonly directory: FileSystemDirectoryHandle };
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
      restored ? State.Selected({ directory: restored }) : State.Ejected(),
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
        yield* Ref.set(ref, State.Selected({ directory: handle }));
      });

    return {
      get: Ref.get(ref),
      changes: ref.changes,

      showDirectoryPicker,
      eject,
    };
  });

type FileTree = Record<string, FileSystemFileHandle>;

const runtime = ManagedRuntime.make(Layer.empty);

const mainActorPromise = runtime.runPromise(makeMainActor());

export function useMainActor() {
  const actor = use(mainActorPromise);

  const value = useSyncExternalStore(
    (callback) => Stream.runForEach(actor.changes, () => Effect.sync(callback)).pipe(runtime.runCallback),
    () => runtime.runSync(actor.get),
  );

  return [value, actor] as const;
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
    </div>
  );
}

// <ul>
//   {Object.entries(actor.context.files ?? {})?.map(([path, file]) => {
//     return <li key={path}>{path}</li>;
//   })}
// </ul>
