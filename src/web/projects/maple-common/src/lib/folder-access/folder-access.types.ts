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

/**
 * A folder the caller already knows about — the currently open folder, or a
 * previously persisted one — used to detect "drop lands inside a folder we
 * already have a handle for" without prompting a new native picker.
 */
export interface KnownFolder {
  handle: MapleFolderHandle;
  native: FileSystemDirectoryHandle;
  /** True when `handle` is the folder currently open in the app. */
  isCurrent: boolean;
}

/**
 * Outcome of resolving an OS drop against the FS Access backend (#2650).
 *
 * - `mounted`        — the drop resolved to a real directory handle: either a
 *   dropped folder, a dropped file (or files) found inside an already-known
 *   folder, or a dropped file (or files) whose containing folder the user
 *   confirmed via a picker seeded at its location (the FS Access API has no
 *   way to read a dropped file's parent directory directly). `filePaths` is
 *   empty for a whole-folder drop; otherwise it holds the paths (relative to
 *   `folder`) of the specific dropped files, for the caller to open or select.
 * - `copy-fallback`  — reference-mounting isn't mechanically possible (no FS
 *   Access support, or the drop couldn't be resolved to real handles); the
 *   caller falls back to the copy-based import pipeline. `reason` is
 *   surfaced to the user so the platform asymmetry is visible, not hidden.
 * - `cancelled`      — the user dismissed a native picker; no import happens.
 */
export type DropResolution =
  | {
      kind: 'mounted';
      folder: MapleFolderHandle;
      filePaths: string[];
      /** True when `folder` was already the active source — the caller
       * should only navigate/select, without remounting it. */
      alreadyOpen: boolean;
    }
  | { kind: 'copy-fallback'; files: File[]; reason: string }
  | { kind: 'cancelled' };
