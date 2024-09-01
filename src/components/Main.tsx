import { useState, useSyncExternalStore } from "react";
import localForage from "localforage";
import { assign, fromPromise, setup, stopChild, type ActorRef, type ActorRefFrom, type AnyActorRef } from "xstate";
import { Effect, Layer, ManagedRuntime, Ref, Stream, SubscriptionRef } from "effect";

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

type State =
  | { type: "ejected" }
  | { type: "selecting" }
  | {
      type: "selected";
      directory: FileSystemDirectoryHandle;
      files?: FileTree;
    };

class CrawlerActor {
  constructor() {}
}

class MainActor {
  get: Effect.Effect<State>;

  showDirectoryPicker: () => Effect.Effect<void>;
  eject: () => Effect.Effect<void>;

  changes: Stream.Stream<State>;

  private constructor(private state: SubscriptionRef.SubscriptionRef<State>) {
    this.get = Ref.get(state);
    this.changes = this.state.changes;

    this.showDirectoryPicker = () =>
      Ref.set(state, { type: "selecting" }).pipe(
        Effect.andThen(() => {
          return Effect.tryPromise({
            try: () => window.showDirectoryPicker(),
            catch: Effect.fail,
          });
        }),
        Effect.andThen((directory) => Ref.set(state, { type: "selected", directory })),
        Effect.catchAll(() => Ref.set(state, { type: "ejected" })),
      );

    this.eject = () => Ref.set(state, { type: "ejected" });
  }

  static make(initial: State) {
    return SubscriptionRef.make(initial).pipe(Effect.map((ref) => new MainActor(ref)));
  }
}

const program = setup({
  types: {
    context: {} as {
      directory?: FileSystemDirectoryHandle;
      files?: FileTree;
      treeCrawler?: ActorRefFrom<typeof treeCrawler>;
    },
    events: {} as
      | { type: "SHOW_DIRECTORY_PICKER" }
      | { type: "REFRESH" }
      | { type: "REFRESH_COMPLETE"; files: FileTree }
      | { type: "EJECT" },
  },
  actors: {
    filePicker: fromPromise(() => {
      return window.showDirectoryPicker();
    }),
    restore: fromPromise(async () => {
      // Ensure when accessing we are always using IndexDB.
      // This ensures we can properly store a directory handle.
      await localForage.setDriver(localForage.INDEXEDDB);

      const directory = await localForage.getItem<FileSystemDirectoryHandle>("directory");
      // TODO: see if we can make a good UX with ultra qukck loading
      await new Promise((res) => setTimeout(res, 500));
      return directory;
    }),
    treeCrawler,
  },
  actions: {
    reset: assign({ directory: undefined }),
    save: async ({ context }) => {
      await localForage.setItem("directory", context.directory);
    },
  },
}).createMachine({
  initial: "restoring",
  always: {
    actions: ["save"],
  },
  on: {
    REFRESH: {
      guard: ({ context }) => !!context.directory,
      actions: [
        stopChild((x) => x.context.treeCrawler?.id ?? "none"),
        assign({
          treeCrawler: ({ spawn, context, self }) =>
            spawn("treeCrawler", {
              input: { directoryHandle: context.directory!, parent: self },
            }),
        }),
      ],
    },
    REFRESH_COMPLETE: {
      actions: assign({ files: ({ event }) => event.files }),
    },
  },
  states: {
    restoring: {
      invoke: {
        src: "restore",
        onDone: [
          {
            guard: ({ event }) => !!event.output,
            target: "selected",
            actions: assign({ directory: ({ event }) => event.output! }),
          },
          {
            target: "empty",
          },
        ],
      },
    },
    empty: {
      entry: ["reset"],
      on: {
        SHOW_DIRECTORY_PICKER: {
          target: "selecting",
        },
      },
    },
    selecting: {
      invoke: {
        src: "filePicker",
        onDone: {
          target: "selected",
          actions: assign({ directory: ({ event }) => event.output }),
        },
        onError: { target: "empty" },
      },
    },
    selected: {
      on: {
        EJECT: {
          target: "empty",
        },
      },
    },
  },
});

type FileTree = Record<string, FileSystemFileHandle>;

// export function useSynchronizedState<T>(ref: Effect.Effect<SubscriptionRef.SubscriptionRef<T>>) {
//   const [subscriptionRef] = useState(Effect.runSync(ref));

//   const value = useSyncExternalStore(
//     (callback) => Stream.runForEach(subscriptionRef.changes, () => Effect.sync(callback)).pipe(Effect.runCallback),
//     () => Effect.runSync(SubscriptionRef.get(subscriptionRef)),
//   );

//   return [value, subscriptionRef] as const;
// }

export function useMainActor() {
  const [runtime] = useState(() => ManagedRuntime.make(Layer.empty));
  const [actor] = useState(() => runtime.runSync(MainActor.make({ type: "ejected" })));

  const value = useSyncExternalStore(
    (callback) => Stream.runForEach(actor.changes, () => Effect.sync(callback)).pipe(Effect.runCallback),
    () => Effect.runSync(actor.get),
  );

  return [value, actor] as const;
}

export function Main() {
  // const [actor, send] = useActor(program);
  // const [value, subscriptionRef] = useSynchronizedState(refEf);
  const [state, actor] = useMainActor();

  return (
    <div className="flex gap-4 flex-col">
      <div className="flex gap-4">
        <button onClick={() => Effect.runPromise(actor.showDirectoryPicker())}>open</button>
        <button onClick={() => Effect.runPromise(actor.eject())}>reset</button>
      </div>
      <p className="block">{state.type}</p>
    </div>
  );
}

// <ul>
//   {Object.entries(actor.context.files ?? {})?.map(([path, file]) => {
//     return <li key={path}>{path}</li>;
//   })}
// </ul>
