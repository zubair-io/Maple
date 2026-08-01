// Types for the unified folder-access abstraction.
// Used by both the FS Access API backend (Chromium) and the fallback backend
// (FileList + IndexedDB for Safari / Firefox).

export type FolderAccessBackend = 'fs-access' | 'fallback';

/**
 * A resolved folder handle, normalized across backends.
 *
 * - `native`       — present when the FS Access API is used (Chromium).
 * - `fallbackFiles`— present in fallback mode; the flat FileList from
 *                    <input webkitdirectory> for the session.
 * - `persistedKey` — IndexedDB key under which the native handle is stored
 *                    so it can be reopened after a page reload.
 */
export interface MapleFolderHandle {
  name: string;
  read: boolean;
  write: boolean;
  native?: FileSystemDirectoryHandle;
  fallbackFiles?: File[];
  persistedKey?: string;
}

/**
 * A single entry (file or sub-directory) inside a folder.
 * The FS Access backend fills `nativeFileHandle` / `nativeDirHandle`;
 * the fallback backend fills `fallbackFile`.
 */
export interface FolderEntry {
  name: string;
  kind: 'file' | 'directory';
  /** Returns the raw File object. Only valid when kind === 'file'. */
  getFile(): Promise<File>;
  /** Returns a sub-folder handle. Only valid when kind === 'directory'. */
  getSubFolder(): Promise<MapleFolderHandle>;
}

export interface FileMetadata {
  size: number;
  lastModified: number;
}

/** Shape stored inside IndexedDB for persisted handles. */
export interface PersistedHandleRecord {
  key: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  accessedAt: number; // unix ms
}
