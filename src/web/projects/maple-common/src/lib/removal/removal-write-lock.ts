// Origin-local coordination for local-folder writes (#3940). The filesystem
// cannot provide an atomic CAS against another application through FS Access.
import type { MapleFolderHandle } from '../folder-access/folder-access.types';

export async function withRemovalWriteLock<T>(
  folder: MapleFolderHandle,
  rawFilename: string,
  write: () => Promise<T>,
): Promise<T> {
  if (!navigator.locks) throw new Error('Photo write coordination is unavailable in this browser.');
  // Folder names can collide: extra serialization is harmless. Folder mounts
  // must resolve to the photo's immediate parent, as the ordinary write path does.
  return navigator.locks.request(`maple-photo-write:${folder.name}:${rawFilename}`, write);
}
