// DropZoneComponent — file import bar + drag-drop overlay + "Open folder" via FS Access API.
// P5: Added FS Access "Open folder" button (Chromium) and read-only permission banner.

import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  inject,
  output,
  signal,
} from '@angular/core';
import { LibraryStateService, isSupportedRaw } from '../../state/library-state.service';
import { errorMessage } from '../../util/errors';
import { AssetId } from '../../models/asset';
import { Router } from '@angular/router';
import { FolderAccessService } from '../../folder-access/folder-access.service';
import { KnownFolder, MapleFolderHandle } from '../../folder-access/folder-access.types';
import { editRouteCommands } from '../../addressing/route-address';

/** Result of resolving a drop to a mounted folder — the branch of
 * `DropResolution` this component acts on once reference-mounting succeeded. */
interface MountedDrop {
  folder: MapleFolderHandle;
  filePaths: string[];
  alreadyOpen: boolean;
}

/** Transient status line reported around a drop, so the platform asymmetry
 * (reference vs. copy) is stated rather than left for the user to guess.
 * `pending` is shown before the seeded confirmation picker opens, so that
 * dialog doesn't appear with zero prior explanation. Access-denied and other
 * failures go through `openError` instead, matching every other failure
 * surface in this component. */
interface DropStatus {
  kind: 'referenced' | 'copied' | 'pending';
  message: string;
}

@Component({
  selector: 'app-drop-zone',
  standalone: true,
  templateUrl: './drop-zone.component.html',
  styleUrl: './drop-zone.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DropZoneComponent {
  readonly imported = output<AssetId[]>();
  readonly folderOpened = output<MapleFolderHandle>();

  readonly state = inject(LibraryStateService);
  readonly folderAccess = inject(FolderAccessService);
  private readonly router = inject(Router);

  readonly dragOver = signal(false);
  readonly importing = signal(false);
  readonly pendingCount = signal(0);
  readonly opening = signal(false);
  readonly openError = signal<string | null>(null);
  /** Which of the two drop outcomes just happened — surfaced so the
   * reference-vs-copy asymmetry (#2650) is stated, not hidden. */
  readonly dropStatus = signal<DropStatus | null>(null);

  /** Text color for the drop-status line, by `DropStatus.kind`. A lookup
   * table rather than template `[class.x]="a === b || a === c"` bindings,
   * both for readability and to keep the template's branch count down. */
  private static readonly DROP_STATUS_COLOR: Record<DropStatus['kind'], string> = {
    referenced: 'text-text-muted',
    pending: 'text-text-muted',
    copied: 'text-warn',
  };

  dropStatusColorClass(kind: DropStatus['kind']): string {
    return DropZoneComponent.DROP_STATUS_COLOR[kind];
  }

  readonly showReadOnlyBanner = () => {
    const folder = this.state.currentFolder();
    return folder !== null && !folder.write;
  };

  // ── FS Access "Open folder" ──────────────────────────────────────────────

  async openFolder(): Promise<void> {
    this.opening.set(true);
    this.openError.set(null);
    try {
      const handle = await this.folderAccess.openFolder();
      if (!handle) {
        // User cancelled — no error.
        return;
      }
      await this.state.openFolder(handle);
      this.folderOpened.emit(handle);
    } catch (err) {
      const msg = errorMessage(err);
      this.openError.set(`Failed to open folder: ${msg}`);
      console.error('DropZoneComponent: openFolder error', err);
    } finally {
      this.opening.set(false);
    }
  }

  async requestWrite(): Promise<void> {
    const folder = this.state.currentFolder();
    if (!folder) return;
    const granted = await this.folderAccess.requestWriteAccess(folder);
    if (!granted) {
      this.openError.set('Write access denied. Edits and thumbnails will not be saved.');
    } else {
      this.openError.set(null);
      // Patch the live signal so the banner hides reactively.
      this.state.currentFolder.update((f) => (f ? { ...f, write: true } : f));
    }
  }

  // ── Drag + drop ─────────────────────────────────────────────────────────

  @HostListener('document:dragover', ['$event'])
  onDragOver(e: DragEvent): void {
    e.preventDefault();
    if (e.dataTransfer?.types.includes('Files')) {
      this.dragOver.set(true);
    }
  }

  @HostListener('document:dragleave', ['$event'])
  onDragLeave(e: DragEvent): void {
    if (e.clientX === 0 && e.clientY === 0) {
      this.dragOver.set(false);
    }
  }

  @HostListener('document:drop', ['$event'])
  async onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    this.dragOver.set(false);
    if (!e.dataTransfer) return;
    await this.handleDrop(e.dataTransfer);
  }

  // ── Drop resolution (#2650) — reference-mount via FS Access when the ─────
  // browser supports it; copy-import stays the explicit fallback otherwise.

  private async handleDrop(dataTransfer: DataTransfer): Promise<void> {
    this.dropStatus.set(null);
    this.openError.set(null);
    try {
      // A drop right after boot can race the constructor's background
      // persisted-handle load — wait for it so `_knownFolders()` doesn't
      // treat an already-known folder as unknown.
      await this.folderAccess.whenPersistedHandlesReady();
      const resolution = await this.folderAccess.resolveDrop(
        dataTransfer,
        this._knownFolders(),
        // Fires just before the seeded confirmation picker opens, so that
        // native dialog doesn't appear with no prior explanation.
        () =>
          this.dropStatus.set({
            kind: 'pending',
            message:
              'Confirm the folder that contains the dropped file so Maple can reference it without copying…',
          }),
      );
      switch (resolution.kind) {
        case 'cancelled':
          this.dropStatus.set(null);
          return;
        case 'access-denied':
          this.dropStatus.set(null);
          this.openError.set(
            `Access to “${resolution.name}” was declined — re-grant it from the sources list, or drop again to copy instead.`,
          );
          return;
        case 'copy-fallback':
          this.dropStatus.set({ kind: 'copied', message: resolution.reason });
          await this.importFiles(resolution.files);
          return;
        case 'mounted':
          await this._openMountedDrop(resolution);
          return;
      }
    } catch (err) {
      this.dropStatus.set(null);
      this.openError.set(`Failed to reference the dropped location: ${errorMessage(err)}`);
      console.error('DropZoneComponent: handleDrop error', err);
    }
  }

  /** The folders Maple already has a handle for — the active folder plus
   * every persisted one — so a drop landing inside one of them mounts
   * silently instead of prompting a fresh native picker. */
  private _knownFolders(): KnownFolder[] {
    const known: KnownFolder[] = [];
    const current = this.state.currentFolder();
    if (current?.native) known.push({ handle: current, native: current.native, isCurrent: true });
    for (const record of this.folderAccess.persistedHandles()) {
      known.push({
        handle: {
          name: record.name,
          read: false,
          write: false,
          native: record.handle,
          persistedKey: record.key,
        },
        native: record.handle,
        isCurrent: false,
      });
    }
    return known;
  }

  private async _openMountedDrop(resolution: MountedDrop): Promise<void> {
    const { folder, filePaths, alreadyOpen } = resolution;
    if (!alreadyOpen) {
      await this.state.openFolder(folder);
      this.folderOpened.emit(folder);
    }

    const ids = this._assetIdsForPaths(filePaths);
    this.dropStatus.set({
      kind: 'referenced',
      message: this._referencedMessage(folder, filePaths, ids),
    });

    // A whole-folder drop has nothing further to select — Browse already
    // shows every asset the folder just contributed.
    if (filePaths.length === 0 || ids.length === 0) return;
    if (ids.length === 1) {
      this.state.selectAsset(ids[0]);
      void this.router.navigate(editRouteCommands(ids[0]));
    } else {
      this.state.selectMany(ids);
    }
  }

  /** Resolve the mounted folder's file names to their asset ids. `filePaths`
   * are always bare basenames within `folder` — `FolderAccessService`
   * resolves a drop down to the files' *immediate* containing directory
   * before returning them (see `fsAccessResolveCommonParent`), so this never
   * has to guess across subfolders or reconcile a multi-segment path against
   * a flat, single-folder asset list. Only files `isSupportedRaw` accepted
   * during enumeration exist here, so a genuinely unsupported dropped file
   * simply won't resolve. */
  private _assetIdsForPaths(filePaths: string[]): AssetId[] {
    const folderId = this.state.selectedSourceId();
    const byFilename = new Map(
      this.state
        .assets()
        .filter((a) => a.folderId === folderId)
        .map((a) => [a.filename, a.id] as const),
    );
    return filePaths.map((p) => byFilename.get(p)).filter((id): id is AssetId => id !== undefined);
  }

  /** `filePaths` and `ids` are the same length unless a dropped name has an
   * extension `isSupportedRaw` rejects — every matchable file resolves (see
   * `_assetIdsForPaths`), so any gap here is a genuinely unsupported type,
   * not a lookup miss. */
  private _referencedMessage(
    folder: MapleFolderHandle,
    filePaths: string[],
    ids: AssetId[],
  ): string {
    if (filePaths.length === 0) return `Referenced “${folder.name}” — no copy made.`;
    const skipped = filePaths.length - ids.length;
    const noun = ids.length === 1 ? 'file' : 'files';
    const skippedNote = skipped > 0 ? ` (${skipped} unsupported file type(s) skipped)` : '';
    return `Referenced ${ids.length} ${noun} in “${folder.name}” — no copy made.${skippedNote}`;
  }

  // ── <input> picker ──────────────────────────────────────────────────────

  onFileInputChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    void this.importFiles(files);
    input.value = '';
  }

  // ── Core import logic (legacy / one-off in-memory path) ────────────────

  private async importFiles(files: File[]): Promise<void> {
    const raws = files.filter((f) => isSupportedRaw(f.name));
    if (!raws.length) return;

    this.importing.set(true);
    this.pendingCount.set(raws.length);

    const ids: AssetId[] = [];
    let done = 0;
    for (const file of raws) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        const id = this.state.addImportedAsset(bytes, file.name);
        ids.push(id);
      } catch (err) {
        console.error(`Failed to read ${file.name}:`, err);
      }
      done++;
      this.pendingCount.set(raws.length - done);
    }

    this.importing.set(false);
    this.pendingCount.set(0);

    if (ids.length > 0) {
      this.state.selectedSourceId.set('f-imported');
      this.state.selectAsset(ids[0]);
      this.imported.emit(ids);
      if (ids.length === 1) void this.router.navigate(editRouteCommands(ids[0]));
    }
  }
}
