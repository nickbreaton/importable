import { startTransition, useActionState, useEffect } from "react";
import localForage from "localforage";

type FileTree = Record<string, FileSystemFileHandle>;

// Ensure when accessing we are always using IndexDB.
// This ensures we can properly store a directory handle.
localForage.setDriver(localForage.INDEXEDDB);

type Payload =
  // | { type: 'restoring' }
  | { type: "select"; directory: FileSystemDirectoryHandle }
  | { type: "restore"; directory: FileSystemDirectoryHandle }
  | { type: "refresh" }
  | { type: "eject" }
  | { type: "ready"; files: FileTree };

type Result = {
  directory?: FileSystemDirectoryHandle;
  files?: FileTree;
};

const CRAWL_DISALLOW = [
  /^\./, // starts with dot
];

async function crawlDirectoryHandle(
  directoryHandle: FileSystemDirectoryHandle,
  previousFiles: FileTree,
  precedingPaths?: string,
): Promise<FileTree> {
  let tree: FileTree = {};

  for await (let handle of directoryHandle.values()) {
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
      const partialTree = await crawlDirectoryHandle(
        handle,
        previousFiles,
        path,
      );
      tree = { ...tree, ...partialTree };
    }
  }

  return tree;
}

export function Main() {
  const [{ directory, files }, submit, isPending] = useActionState<
    Result,
    Payload
  >(async (state, payload) => {
    if (payload.type === "eject") {
      return {};
    }

    if (
      (payload.type === "select" || payload.type === "restore") &&
      payload.directory
    ) {
      await localForage.setItem("selected", payload.directory);
      startTransition(() => {
        submit({ type: "refresh" });
      });
      return { ...state, directory: payload.directory };
    }

    if (payload.type === "refresh" && state.directory) {
      await new Promise((res) => setTimeout(res, 1000));

      try {
        const files = await crawlDirectoryHandle(
          state.directory,
          state.files ?? {},
        );
        return { ...state, files };
      } catch (error) {
        console.error(error);
        startTransition(() => submit({ type: "eject" }));
      }
    }

    return state;
  }, {});

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      startTransition(() => submit({ type: "refresh" }));
    };
    window.addEventListener("focus", refresh, {
      signal: controller.signal,
    });
    document.addEventListener("mouseenter", refresh, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    localForage.setDriver(localForage.INDEXEDDB).then(async () => {
      const handle =
        await localForage.getItem<FileSystemDirectoryHandle>("selected");

      if (handle) {
        startTransition(() => {
          submit({ type: "restore", directory: handle });
        });
      }
    });
  }, []);

  return (
    <div>
      {directory ? (
        <div>
          <span>{directory.name}</span>
          <hr />
          <ul>
            {Object.entries(files ?? {}).map(([path, file]) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div>
          <button
            onClick={async () => {
              const directory = await window.showDirectoryPicker({
                mode: "readwrite",
              });
              startTransition(() => {
                submit({ type: "select", directory: directory });
              });
            }}
          >
            Select a drive
          </button>
        </div>
      )}
    </div>
  );
}
