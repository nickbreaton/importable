import { SerializeFrom } from "@remix-run/node";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import localForage from "localforage";
import { useEffect } from "react";
import treeify, { TreeObject } from "treeify";

const STORAGE_KEY = "directory_handle";

const CRAWL_DISALLOW = [
  /^\./, // starts with dot
];

type Images = FileSystemFileHandle[];

async function crawlDirectoryHandle(directoryHandle: FileSystemDirectoryHandle): Promise<[TreeObject, Images]> {
  const tree: TreeObject = {};
  const images: Images = [];

  for await (const handle of directoryHandle.values()) {
    if (CRAWL_DISALLOW.some((disallowed) => handle.name.match(disallowed))) {
      // console.warn(` Disallowed "${handle.name}"`);
      continue;
    }

    if (handle.kind === "file") {
      tree[handle.name] = "";
      images.push(handle);
    } else {
      const [childTree, childImages] = await crawlDirectoryHandle(handle);
      tree[`${handle.name}/`] = childTree;
      images.push(...childImages);
    }
  }

  return [tree, images];
}

async function isLikelyUnmounted(directoryHandle: FileSystemDirectoryHandle) {
  try {
    await directoryHandle.keys().next();
  } catch {
    return true;
  }
  return false;
}

type Selected<T extends { selected: boolean }> = T extends { selected: true } ? T : never;

function assertSelected<T extends SerializeFrom<typeof clientLoader>>(data: T): asserts data is Selected<T> {
  if (!data.selected) {
    throw new Error("Expected data to be of selected variant");
  }
}

function assertFullHandle<T extends FileSystemFileHandle | FileSystemDirectoryHandle>(
  reference: JsonifyObject<T>
): asserts reference is T {
  // 😉
}

function extname(file: FileSystemFileHandle) {
  return file.name.match(/\.(\w+)$/)?.at(0) ?? "";
}

export async function clientLoader() {
  // Ensure when accessing we are always using IndexDB.
  // This ensures we can properly store a directory handle.
  localForage.setDriver(localForage.INDEXEDDB);

  const directoryHandle = await localForage.getItem<FileSystemDirectoryHandle>(STORAGE_KEY);

  if (!directoryHandle || (await isLikelyUnmounted(directoryHandle))) {
    await localForage.removeItem(STORAGE_KEY);
    return { selected: false as const };
  }

  const [tree, images] = await crawlDirectoryHandle(directoryHandle);

  return {
    selected: true as const,
    directoryName: directoryHandle.name,
    handle: directoryHandle,
    tree: treeify.asTree(tree, false, true),
    images: images,
  };
}

function useRevalidateOnWindowFocus() {
  const revalidator = useRevalidator();
  useEffect(() => {
    const controller = new AbortController();
    window.addEventListener("focus", () => revalidator.revalidate(), { signal: controller.signal });
    return () => controller.abort();
  }, [revalidator]);
}

declare global {
  interface FileSystemFileHandle {
    move(destination: FileSystemDirectoryHandle, name?: string): Promise<void>;
  }
}

export default function Index() {
  useRevalidateOnWindowFocus();

  const data = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();

  async function openDirectoryPicker() {
    const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    await localForage.setItem(STORAGE_KEY, directoryHandle);
    revalidator.revalidate();
  }

  async function organizeFiles() {
    assertSelected(data);
    assertFullHandle(data.handle);

    const DCIM = await data.handle.getDirectoryHandle("DCIM", { create: true });
    const destination = await DCIM.getDirectoryHandle("100MEDIA", { create: true });

    for (let index = 0; index < data.images.length; index++) {
      const image = data.images.at(index);
      assertFullHandle(image);
      const ext = extname(image);
      await image.move(destination, `IMG_${String(index).padStart(4, "0")}${ext}`); // TODO: 1 pad index properly, carry over extension
    }

    revalidator.revalidate();
  }

  return (
    <div className="font-sans p-4">
      <button onClick={openDirectoryPicker}>Open drive</button>
      {data.selected && (
        <div>
          <h1>{data.directoryName}</h1>
          <pre>{data.tree}</pre>
          <button className="py-2 px-4 bg-sky-50 border-sky-500 text-sky-500 border-2 rounded" onClick={organizeFiles}>
            Do magic 🪄
          </button>
        </div>
      )}
    </div>
  );
}
