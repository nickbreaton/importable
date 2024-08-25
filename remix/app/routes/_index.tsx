import { Await, useLoaderData, useRevalidator } from "@remix-run/react";
import localForage from "localforage";
import { Suspense, useEffect, useState } from "react";
import treeify, { TreeObject } from "treeify";
import { GitHubButton } from "~/components/GitHubButton";
import reduce from "image-blob-reduce";
import { getStableFileSystemHandle } from "~/lib/files";
import { useRevalidateOnWindowFocus } from "~/lib/revalidate";

const STORAGE_KEY = "directory_handle";

const CRAWL_DISALLOW = [
  /^\./, // starts with dot
];

const imageContainerCache = new WeakMap<FileSystemFileHandle, ImageContainer>();

class ImageContainer {
  constructor(public fullPath: string, public handle: FileSystemFileHandle) {}

  #thumbnail?: Promise<Blob>;

  async getThumbnail() {
    this.#thumbnail ??= this.handle.getFile().then((file) => {
      console.log("get thumbnail", this.fullPath);
      return reduce()
        .toBlob(file, { max: 300 })
        .catch(() => file);
    });
    return await this.#thumbnail;
  }
}

async function crawlDirectoryHandle(
  directoryHandle: FileSystemDirectoryHandle,
  precedingPaths: string[] = []
): Promise<[TreeObject, ImageContainer[]]> {
  const tree: TreeObject = {};
  const images: ImageContainer[] = [];

  for await (const unstableHandle of directoryHandle.values()) {
    if (CRAWL_DISALLOW.some((disallowed) => unstableHandle.name.match(disallowed))) {
      continue;
    }

    const fullPath = [...precedingPaths, unstableHandle.name];
    const fullPathKey = fullPath.join("/");

    const handle = getStableFileSystemHandle(fullPathKey, unstableHandle);

    if (handle.kind === "file") {
      tree[handle.name] = "";
      const container = imageContainerCache.get(handle) ?? new ImageContainer(fullPathKey, handle);
      imageContainerCache.set(handle, container);
      images.push(container);
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

function assertSelected<T extends Awaited<ReturnType<typeof clientLoader>>>(data: T): asserts data is Selected<T> {
  if (!data.selected) {
    throw new Error("Expected data to be of selected variant");
  }
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

  const firstThumbnailsPreload = Promise.all(images.slice(0, 20).map((container) => container.getThumbnail()));

  return {
    selected: true as const,
    directoryName: directoryHandle.name,
    handle: directoryHandle,
    tree: treeify.asTree(tree, false, true),
    images: images,
    firstThumbnailsPreload,
  };
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

const ImageThumbnail = ({ container }: { container: ImageContainer }) => {
  const [src, setSrc] = useState<string>();

  useEffect(() => {
    let url: string | null = null;

    container.getThumbnail().then((thumbnail) => {
      url = URL.createObjectURL(thumbnail);
      setSrc(url);
    });

    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [container]);

  return (
    <div className="aspect-square w-full rounded overflow-hidden pointer-events-none select-none">
      <img src={src} alt="" className="object-cover w-full h-full" />
    </div>
  );
};

function useClientLoaderData<T extends () => unknown>() {
  return useLoaderData() as Awaited<ReturnType<T>>;
}

export default function Index() {
  useRevalidateOnWindowFocus();

  const data = useClientLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();

  async function openDirectoryPicker() {
    const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    await localForage.setItem(STORAGE_KEY, directoryHandle);
    revalidator.revalidate();
  }

  async function organizeFiles() {
    assertSelected(data);

    const DCIM = await data.handle.getDirectoryHandle("DCIM", { create: true });
    const destination = await DCIM.getDirectoryHandle("100MEDIA", { create: true });

    for (let index = 0; index < data.images.length; index++) {
      const container = data.images.at(index);
      const image = container!.handle;
      const ext = extname(image);
      await image.move(destination, `IMG_${String(index).padStart(4, "0")}${ext}`); // TODO: 1 pad index properly, carry over extension
    }

    revalidator.revalidate();
  }

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
            {/* <pre>{data.tree}</pre> */}
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
            <Suspense>
              <Await resolve={data.firstThumbnailsPreload}>
                <div className="grid grid-cols-5 gap-2">
                  {data.images.map((image) => (
                    <ImageThumbnail container={image} key={image.fullPath} />
                  ))}
                </div>
              </Await>
            </Suspense>
          </Pannel>
          <Pannel>x</Pannel>
        </div>
      )}
    </Layout>
  );
}