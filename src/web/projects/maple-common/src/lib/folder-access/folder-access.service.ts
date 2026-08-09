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
  KnownFolder,
  DropResolution,
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
  fsAccessResolveCommonParent,
  fsAccessPickContainingFolder,
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
import { FolderAccessError } from './folder-access.error';

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

  /** Settles once the constructor's background persisted-handle load has
   * finished. `resolveDrop` callers should await `whenPersistedHandlesReady()`
   * first — otherwise a drop fired right after boot would see an empty
   * `persistedHandles()` and treat an already-known folder as unknown. */
  private readonly _persistedHandlesReady: Promise<void>;

  constructor() {
    // Load persisted handles in the background; don't block construction —
    // callers that need them settled (resolveDrop) await the promise instead.
    this._persistedHandlesReady = this.hasFsAccess
      ? this._loadPersistedHandles()
      : Promise.resolve();
  }

  /** Resolves once the initial persisted-handle load has settled. */
  async whenPersistedHandlesReady(): Promise<void> {
    await this._persistedHandlesReady;
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
   * Returns `null` if the user cancels. Permission failures are named errors.
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
   * Resolve an OS drop for reference-mounting (#2650) — same mechanism as
   * `openFolder`'s "Open folder" flow, extended to the drop gesture and to
   * loose files. See `DropResolution` for the four outcomes this maps onto
   * (single file, folder, multiple loose files, already-mounted) and why a
   * loose file that isn't inside a known folder needs one more picker
   * confirmation (the FS Access API exposes no parent-directory lookup).
   *
   * `knownFolders` — the folders Maple already has a handle for (typically
   * the currently open folder plus every persisted handle) — is supplied by
   * the caller rather than read from state here, to avoid this service
   * depending on `LibraryStateService`. Callers should `await
   * whenPersistedHandlesReady()` before building that list, or a drop right
   * after boot can miss a folder whose persisted-handle load hadn't landed
   * yet.
   *
   * `onBeforePicker`, if given, fires immediately before a loose-file drop
   * that isn't inside any known folder opens the seeded confirmation picker
   * — callers use it to show an explanation ahead of that native dialog
   * rather than have it appear with no context.
   *
   * A permission failure while re-opening an already-identified but
   * not-currently-open known folder (its location was positively found, but
   * access has since been revoked or expired) resolves to `access-denied`
   * rather than throwing — see `_mountIfInsideKnownFolder`. That's a
   * different situation from "couldn't be resolved at all"
   * (`copy-fallback`): the referenced location is known, just not currently
   * reachable, so re-granting fixes it. A permission failure anywhere else
   * (e.g. the folder-drop or picker-confirm consent prompt itself being
   * denied) is a fresh, never-granted consent request, not a revocation —
   * those still throw for the caller's generic error handling.
   */
  async resolveDrop(
    dataTransfer: DataTransfer,
    knownFolders: KnownFolder[],
    onBeforePicker?: () => void,
  ): Promise<DropResolution> {
    if (this.backend !== 'fs-access') {
      return this._copyFallback(
        dataTransfer,
        'This browser cannot reference dropped files in place',
      );
    }

    const resolved = await this._getDroppedHandles(dataTransfer);
    if (!resolved) {
      return this._copyFallback(
        dataTransfer,
        'This browser could not resolve the dropped item(s) to a file location',
      );
    }
    const directories = resolved.filter(
      (h): h is FileSystemDirectoryHandle => h.kind === 'directory',
    );
    const files = resolved.filter((h): h is FileSystemFileHandle => h.kind === 'file');

    // Case: a single dropped folder — mount it directly, same as "Open folder".
    if (directories.length === 1 && files.length === 0) {
      return this._mountDroppedFolder(directories[0], knownFolders);
    }

    // Folders mixed with loose files, or several folders at once, fall
    // outside the four supported cases — copy rather than guess.
    if (directories.length > 0 || files.length === 0) {
      return this._copyFallback(
        dataTransfer,
        'Dropping folders together with loose files is not supported for reference mounting',
      );
    }

    return this._mountDroppedFiles(dataTransfer, files, knownFolders, onBeforePicker);
  }

  private _copyFallback(dataTransfer: DataTransfer, reason: string): DropResolution {
    return {
      kind: 'copy-fallback',
      files: Array.from(dataTransfer.files),
      reason: `${reason} — copied instead.`,
    };
  }

  /** Resolve every dropped item to its FS Access handle, or null if any item
   * couldn't be resolved (the whole drop then falls back to copy-import). */
  private async _getDroppedHandles(dataTransfer: DataTransfer): Promise<FileSystemHandle[] | null> {
    const items = Array.from(dataTransfer.items).filter((item) => item.kind === 'file');
    const handles = await Promise.all(
      items.map(
        (item) =>
          (item as DataTransferItemWithHandle).getAsFileSystemHandle?.() ?? Promise.resolve(null),
      ),
    );
    if (handles.length === 0 || handles.some((h) => !h)) return null;
    return handles as FileSystemHandle[];
  }

  /** A single dropped folder — mount it exactly like the "Open folder" flow. */
  private async _mountDroppedFolder(
    dir: FileSystemDirectoryHandle,
    knownFolders: KnownFolder[],
  ): Promise<DropResolution> {
    const folder = await fsAccessOpenDroppedFolder(dir);
    if (!folder) return { kind: 'cancelled' };
    if (folder.persistedKey) await this._loadPersistedHandles();
    const current = knownFolders.find((kf) => kf.isCurrent);
    const alreadyOpen = current !== undefined && (await current.native.isSameEntry(dir));
    return { kind: 'mounted', folder, filePaths: [], alreadyOpen };
  }

  /** One or more dropped loose files. Reuses a known folder's handle when the
   * drop lands inside one; otherwise confirms the parent via a seeded picker
   * (the FS Access API has no parent-directory lookup for a lone file). */
  private async _mountDroppedFiles(
    dataTransfer: DataTransfer,
    files: FileSystemFileHandle[],
    knownFolders: KnownFolder[],
    onBeforePicker?: () => void,
  ): Promise<DropResolution> {
    const inKnownFolder = await this._mountIfInsideKnownFolder(files, knownFolders);
    if (inKnownFolder) return inKnownFolder;
    onBeforePicker?.();
    return this._mountViaSeededPicker(dataTransfer, files);
  }

  /**
   * Try every known folder for one whose subtree contains all of `files` as
   * siblings, mounting the files' *immediate* containing directory — which
   * may be a subfolder of `known`, not `known` itself; see
   * `fsAccessResolveCommonParent`.
   */
  private async _mountIfInsideKnownFolder(
    files: FileSystemFileHandle[],
    knownFolders: KnownFolder[],
  ): Promise<DropResolution | null> {
    for (const known of knownFolders) {
      const match = await fsAccessResolveCommonParent(known.native, files);
      if (!match) continue;
      const resolution =
        match.dir === known.native
          ? await this._mountKnownFolderItself(known, match.fileNames)
          : await this._mountSubfolderOfKnown(match.dir, match.fileNames);
      if (resolution) return resolution;
    }
    return null;
  }

  /**
   * The drop landed directly in `known` itself. A permission failure while
   * re-opening it resolves to `access-denied` rather than throwing:
   * `resolve()` already positively proved this drop belongs to `known`, so
   * "couldn't reach it" here specifically means access to an identified
   * location was revoked, not a fresh consent denial — worth a distinct,
   * actionable outcome for the caller.
   */
  private async _mountKnownFolderItself(
    known: KnownFolder,
    fileNames: string[],
  ): Promise<DropResolution | null> {
    if (known.isCurrent) {
      return { kind: 'mounted', folder: known.handle, filePaths: fileNames, alreadyOpen: true };
    }
    try {
      const reopened = await fsAccessReopenHandle({
        key: known.handle.persistedKey ?? '',
        name: known.handle.name,
        handle: known.native,
        accessedAt: Date.now(),
      });
      return reopened
        ? { kind: 'mounted', folder: reopened, filePaths: fileNames, alreadyOpen: false }
        : null;
    } catch (err) {
      if (err instanceof FolderAccessError)
        return { kind: 'access-denied', name: known.handle.name };
      throw err;
    }
  }

  /**
   * The drop landed in a subfolder of a known folder — mount that subfolder
   * directly (its own reference identity, its own permission grant), not
   * the higher-level root, so the dropped file(s) become ordinary top-level
   * assets of their real containing folder. This is a fresh mount (never
   * previously granted), so a denial here is a normal consent decline, not
   * a revocation — let it throw like any other first-time mount.
   */
  private async _mountSubfolderOfKnown(
    dir: FileSystemDirectoryHandle,
    fileNames: string[],
  ): Promise<DropResolution | null> {
    const folder = await fsAccessOpenDroppedFolder(dir);
    return folder ? { kind: 'mounted', folder, filePaths: fileNames, alreadyOpen: false } : null;
  }

  /** No known folder contains the drop — confirm its parent via a directory
   * picker seeded at the first file's location. */
  private async _mountViaSeededPicker(
    dataTransfer: DataTransfer,
    files: FileSystemFileHandle[],
  ): Promise<DropResolution> {
    const picked = await fsAccessPickContainingFolder(files[0]);
    if (!picked) return { kind: 'cancelled' };
    const match = await fsAccessResolveCommonParent(picked, files);
    if (!match) {
      return this._copyFallback(
        dataTransfer,
        'The selected folder did not contain the dropped file(s)',
      );
    }
    const folder = await fsAccessOpenDroppedFolder(match.dir);
    if (!folder) return { kind: 'cancelled' };
    if (folder.persistedKey) await this._loadPersistedHandles();
    return { kind: 'mounted', folder, filePaths: match.fileNames, alreadyOpen: false };
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
