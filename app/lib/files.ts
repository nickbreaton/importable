// Note: keys are never cleaned up, maybe do something about that
const knownFileSystemHandles = new Map<string, WeakRef<FileSystemFileHandle | FileSystemDirectoryHandle>>();

/**
 * Reading entries of a directory handle do not yield the same reference even if it is the same handle.
 * Using a path key we can attempt to see if we are still holding that reference from the last lookup.
 */
export function getStableFileSystemHandle<T extends FileSystemFileHandle | FileSystemDirectoryHandle>(
  pathKey: string,
  handle: T
): T {
  const previousHandle = knownFileSystemHandles.get(pathKey)?.deref();
  const stableHandle = previousHandle?.isSameEntry(handle) ? previousHandle : handle;
  const nextWeakRef = new WeakRef(stableHandle);
  knownFileSystemHandles.set(pathKey, nextWeakRef);
  return stableHandle as T;
}
