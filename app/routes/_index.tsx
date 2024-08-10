import { SerializeFrom } from "@remix-run/node";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import localForage from "localforage";
import { useEffect, useState } from "react";
import treeify, { TreeObject } from "treeify";
import { GitHubButton } from "~/components/GitHubButton";
import reduce from "image-blob-reduce";

const STORAGE_KEY = "directory_handle";

const CRAWL_DISALLOW = [
  /^\./, // starts with dot
];

type Images = FileSystemFileHandle[];

const knownHandles = new Map<string, WeakRef<FileSystemFileHandle | FileSystemDirectoryHandle>>();

async function crawlDirectoryHandle(
  directoryHandle: FileSystemDirectoryHandle,
  precedingPaths: string[] = []
): Promise<[TreeObject, Images]> {
  const tree: TreeObject = {};
  const images: Images = [];

  for await (let handle of directoryHandle.values()) {
    if (CRAWL_DISALLOW.some((disallowed) => handle.name.match(disallowed))) {
      // console.warn(` Disallowed "${handle.name}"`);
      continue;
    }

    console.log(precedingPaths);

    const fullPath = [...precedingPaths, handle.name];
    const fullPathKey = fullPath.join("/");

    const previousFileHandle = knownHandles.get(fullPathKey)?.deref();

    handle = previousFileHandle?.isSameEntry(handle) ? previousFileHandle : handle;
    knownHandles.set(fullPathKey, new WeakRef(handle));

    if (handle.kind === "file") {
      tree[handle.name] = "";
      images.push(handle);
    } else {
      const [childTree, childImages] = await crawlDirectoryHandle(handle, fullPath);
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
    window.addEventListener("focus", revalidator.revalidate, { signal: controller.signal });
    document.addEventListener("mouseenter", revalidator.revalidate, { signal: controller.signal });
    return () => controller.abort();
  }, [revalidator]);
}

declare global {
  interface FileSystemFileHandle {
    move(destination: FileSystemDirectoryHandle, name?: string): Promise<void>;
  }
}

const Layout = ({ children }: { children: React.ReactNode }) => (
  <div className="p-3 flex justify-center">
    <div className="max-w-screen-xl flex-1">{children}</div>
  </div>
);

const Pannel = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-md p-2 border-slate-200 border-solid border min-h-72">{children}</div>
);

const ImageThumbnail = ({ file }: { file: FileSystemFileHandle }) => {
  const [src, setSrc] = useState<string>();

  useEffect(() => {
    if (file) {
      let url: string | null = null;

      file.getFile().then(async (blob) => {
        const reducedBlob = await reduce().toBlob(blob, { max: 300 });
        url = URL.createObjectURL(reducedBlob);
        setSrc(url);
      });

      return () => {
        if (url) {
          URL.revokeObjectURL(url);
        }
      };
    }
  }, [file]);

  return (
    <div className="aspect-square w-full rounded overflow-hidden pointer-events-none select-none">
      <img src={src} alt="" className="object-cover w-full h-full" />
    </div>
  );
};

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

  // if (data.selected) {
  //   for (const image of data.images) {
  //     set.add(image);
  //   }
  // }

  // console.log(set);

  return (
    <Layout>
      <div className="font-sans bg-white p-5">
        <div className="flex justify-between">
          <button onClick={openDirectoryPicker}>Open drive</button>
          <GitHubButton />
        </div>
        {data.selected && (
          <div>
            <h1>{data.directoryName}</h1>
            <pre>{data.tree}</pre>
            <button
              className="py-2 px-4 bg-sky-50 border-sky-500 text-sky-500 border-2 rounded"
              onClick={organizeFiles}
            >
              Do magic 🪄
            </button>
          </div>
        )}
      </div>
      {data.selected && (
        <div className="grid gap-2 md:grid-cols-2">
          <Pannel>
            <div className="grid grid-cols-5 gap-2">
              {data.images.map((image) => (
                <ImageThumbnail file={image} key={image.name} />
              ))}
            </div>
          </Pannel>
          <Pannel>x</Pannel>
        </div>
      )}
    </Layout>
  );
}
