// FolderAccessService — unified folder I/O regardless of backend.
//
// - On Chromium (FS Access API available): delegates to fs-access-backend.ts.
// - On Safari / Firefox (no FS Access API): delegates to fallback-backend.ts.
//
// Callers never import a backend directly; they always go through this service.

import { Injectable, signal } from '@angular/core';
import {
  MapleFolderHandle,
  FolderEntry,
  PersistedHandleRecord,
  FolderAccessBackend,
  FileMetadata,
} from './folder-access.types';
import {
  fsAccessOpenFolder,
  fsAccessOpenDroppedFolder,
  fsAccessReopenHandle,
  fsAccessRequestWrite,
  fsAccessListEntries,
  fsAccessReadFile,
  fsAccessFileMetadata,
  fsAccessWriteFile,
  fsAccessEnsureSubdirectory,
  getPersistedHandles,
  removePersistedHandle,
} from './fs-access-backend';
import {
  fallbackOpenFolder,
  fallbackListEntries,
  fallbackReadFile,
  fallbackFileMetadata,
  fallbackWriteFile,
  fallbackEnsureSubdirectory,
} from './fallback-backend';

interface DataTransferItemWithHandle extends DataTransferItem {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
}

@Injectable({ providedIn: 'root' })
export class FolderAccessService {
  /** The active backend detected at construction time. */
  readonly backend: FolderAccessBackend = this._detectBackend();

  /**
   * True when the FS Access API is available.
   * Components can use this to decide whether to show the "Open folder" button.
   */
  readonly hasFsAccess: boolean = this.backend === 'fs-access';

  /** Persisted handles the user has opened before (FS Access only). */
  readonly persistedHandles = signal<PersistedHandleRecord[]>([]);

  constructor() {
    if (this.hasFsAccess) {
      // Load persisted handles in the background; don't block construction.
      void this._loadPersistedHandles();
    }
  }

  // ── Backend detection ──────────────────────────────────────────────────────

  private _detectBackend(): FolderAccessBackend {
    if (typeof window !== 'undefined' && 'showDirectoryPicker' in window) {
      return 'fs-access';
    }
    return 'fallback';
  }

  // ── Open folder ────────────────────────────────────────────────────────────

  /**
   * Prompt the user to choose a folder.
   * Returns `null` if the user cancelled or denied permission.
   */
  async openFolder(): Promise<MapleFolderHandle | null> {
    if (this.backend === 'fs-access') {
      const handle = await fsAccessOpenFolder();
      if (handle?.persistedKey) {
        await this._loadPersistedHandles();
      }
      return handle;
    }
    return fallbackOpenFolder();
  }

  /** Resolve a directory dragged from the OS without opening another picker. */
  async openDroppedFolder(dataTransfer: DataTransfer): Promise<MapleFolderHandle | null> {
    if (this.backend !== 'fs-access') return null;

    for (const item of Array.from(dataTransfer.items)) {
      const handle = await (item as DataTransferItemWithHandle).getAsFileSystemHandle?.();
      if (handle?.kind === 'directory') {
        return fsAccessOpenDroppedFolder(handle as FileSystemDirectoryHandle);
      }
    }
    return null;
  }

  /**
   * Re-open a persisted handle (FS Access only).
   * The browser re-prompts for permission after a page reload.
   */
  async reopenPersistedHandle(record: PersistedHandleRecord): Promise<MapleFolderHandle | null> {
    return fsAccessReopenHandle(record);
  }

  /** Forget a persisted handle from IndexedDB. */
  async removePersistedHandle(key: string): Promise<void> {
    await removePersistedHandle(key);
    await this._loadPersistedHandles();
  }

  /**
   * Request write permission for an existing read-only handle.
   * Returns true if permission was granted.
   */
  async requestWriteAccess(folder: MapleFolderHandle): Promise<boolean> {
    if (this.backend !== 'fs-access') return false;
    const granted = await fsAccessRequestWrite(folder);
    if (granted) folder.write = true;
    return granted;
  }

  // ── Directory listing ──────────────────────────────────────────────────────

  /**
   * List all entries (files and directories) directly inside `folder`.
   */
  async listEntries(folder: MapleFolderHandle): Promise<FolderEntry[]> {
    if (this.backend === 'fs-access') {
      return fsAccessListEntries(folder);
    }
    return fallbackListEntries(folder);
  }

  // ── File I/O ───────────────────────────────────────────────────────────────

  /**
   * Read a file at `path` relative to `folder`.
   * `path` may include slashes, e.g. `.maple/index.json`.
   * Throws on not-found or permission errors.
   */
  async readFile(folder: MapleFolderHandle, path: string): Promise<Uint8Array> {
    if (this.backend === 'fs-access') {
      return fsAccessReadFile(folder, path);
    }
    return fallbackReadFile(folder, path);
  }

  async fileMetadata(folder: MapleFolderHandle, path: string): Promise<FileMetadata> {
    return this.backend === 'fs-access'
      ? fsAccessFileMetadata(folder, path)
      : fallbackFileMetadata(folder, path);
  }

  /**
   * Write `data` to `path` relative to `folder`.
   * Creates intermediate directories as needed (FS Access backend only).
   * In fallback mode, writes to IndexedDB.
   */
  async writeFile(folder: MapleFolderHandle, path: string, data: Uint8Array): Promise<void> {
    if (this.backend === 'fs-access') {
      return fsAccessWriteFile(folder, path, data);
    }
    return fallbackWriteFile(folder, path, data);
  }

  /**
   * Ensure a subdirectory exists inside `folder`.
   * `name` may contain slashes: `ensureSubdirectory(folder, '.maple/thumbs')`.
   * Returns a handle to the subdirectory.
   */
  async ensureSubdirectory(folder: MapleFolderHandle, name: string): Promise<MapleFolderHandle> {
    if (this.backend === 'fs-access') {
      return fsAccessEnsureSubdirectory(folder, name);
    }
    return fallbackEnsureSubdirectory(folder, name);
  }

  // ── Persisted handles ──────────────────────────────────────────────────────

  private async _loadPersistedHandles(): Promise<void> {
    try {
      const records = await getPersistedHandles();
      // Sort newest first.
      records.sort((a, b) => b.accessedAt - a.accessedAt);
      this.persistedHandles.set(records);
    } catch {
      this.persistedHandles.set([]);
    }
  }
}
