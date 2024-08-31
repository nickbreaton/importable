import { useEffect } from "react";
import localForage from "localforage";
import {
  assign,
  fromPromise,
  setup,
  stopChild,
  type ActorRef,
  type ActorRefFrom,
  type AnyActorRef,
} from "xstate";
import { useActor } from "@xstate/react";

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
    handle = (await previousFiles[path]?.isSameEntry(handle))
      ? previousFiles[path]
      : handle;

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

const treeCrawler = fromPromise<
  void,
  { directoryHandle: FileSystemDirectoryHandle; parent: AnyActorRef }
>(async ({ signal, input: { directoryHandle, parent } }) => {
  const result = await crawlDirectoryHandle({
    signal,
    directoryHandle,
    previousFiles: {},
  });

  if (!signal.aborted) {
    parent.send({ type: "REFRESH_COMPLETE", files: result });
  }
});

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

      const directory =
        await localForage.getItem<FileSystemDirectoryHandle>("directory");
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

export function Main() {
  const [actor, send] = useActor(program);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => send({ type: "REFRESH" });
    refresh();
    window.addEventListener("focus", refresh, {
      signal: controller.signal,
    });
    document.addEventListener("mouseenter", refresh, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, []);

  return (
    <div className="flex gap-4 flex-col">
      <div className="flex gap-4">
        <button onClick={() => send({ type: "SHOW_DIRECTORY_PICKER" })}>
          open
        </button>
        {actor.can({ type: "EJECT" }) && (
          <button onClick={() => send({ type: "EJECT" })}>reset</button>
        )}
      </div>
      <p className="block">
        {actor.value} : {actor.context.directory?.name}
      </p>
      <ul>
        {Object.entries(actor.context.files ?? {})?.map(([path, file]) => {
          return <li key={path}>{path}</li>;
        })}
      </ul>
    </div>
  );
}
