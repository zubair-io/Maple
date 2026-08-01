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
import { MapleFolderHandle } from '../../folder-access/folder-access.types';
import { editRouteCommands } from '../../addressing/route-address';

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
  onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dragOver.set(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    void this.importFiles(files);
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
