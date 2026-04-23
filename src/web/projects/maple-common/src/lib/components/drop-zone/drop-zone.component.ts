// DropZoneComponent — file import bar + drag-drop overlay + "Open folder" via FS Access API.
// P5: Added FS Access "Open folder" button (Chromium) and read-only permission banner.

import {
  Component,
  EventEmitter,
  HostListener,
  Output,
  inject,
  signal,
} from '@angular/core';
import { LibraryStateService, isSupportedRaw } from '../../state/library-state.service';
import { AssetId } from '../../models/asset';
import { FolderAccessService } from '../../folder-access/folder-access.service';
import { MapleFolderHandle } from '../../folder-access/folder-access.types';

@Component({
  selector: 'app-drop-zone',
  standalone: true,
  styles: [`
    :host { display: contents; }

    .drop-overlay {
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: rgba(0,0,0,0.65);
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }

    .drop-box {
      border: 2px dashed var(--maple-primary);
      border-radius: 12px;
      padding: 40px 60px;
      text-align: center;
      font-family: var(--maple-font);
      font-size: 15px;
      color: var(--maple-primary);
      letter-spacing: 0.02em;
    }

    .import-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 32px;
      padding: 0 10px;
      background: var(--maple-surface);
      border-bottom: 0.5px solid var(--maple-border);
      flex-shrink: 0;
    }

    .import-btn {
      display: flex;
      align-items: center;
      gap: 5px;
      height: 22px;
      padding: 0 10px;
      border-radius: 4px;
      background: var(--maple-surface-alt);
      border: 0.5px solid var(--maple-border);
      color: var(--maple-text-main);
      font-family: var(--maple-font);
      font-size: 11px;
      cursor: pointer;
      transition: background 120ms;
    }
    .import-btn:hover { background: var(--maple-surface-hover); }

    .import-btn.primary {
      background: var(--maple-primary-dim);
      border-color: var(--maple-primary);
      color: var(--maple-primary);
    }
    .import-btn.primary:hover {
      background: color-mix(in srgb, var(--maple-primary) 20%, transparent);
    }

    .import-status {
      font-family: var(--maple-font);
      font-size: 11px;
      color: var(--maple-text-muted);
    }

    /* Read-only banner */
    .readonly-banner {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 28px;
      padding: 0 10px;
      background: color-mix(in srgb, var(--maple-warning, #d97706) 12%, var(--maple-surface));
      border-bottom: 0.5px solid color-mix(in srgb, var(--maple-warning, #d97706) 40%, transparent);
      flex-shrink: 0;
      font-family: var(--maple-font);
      font-size: 11px;
      color: var(--maple-warning, #d97706);
    }
    .readonly-banner .grant-btn {
      height: 18px;
      padding: 0 8px;
      border-radius: 3px;
      background: color-mix(in srgb, var(--maple-warning, #d97706) 20%, transparent);
      border: 0.5px solid var(--maple-warning, #d97706);
      color: var(--maple-warning, #d97706);
      font-family: var(--maple-font);
      font-size: 10px;
      cursor: pointer;
    }
    .readonly-banner .grant-btn:hover {
      background: color-mix(in srgb, var(--maple-warning, #d97706) 30%, transparent);
    }

    /* Hidden file inputs */
    input[type=file] { display: none; }
  `],
  template: `
    <!-- Import toolbar row -->
    <div class="import-bar">
      <!-- FS Access "Open folder" button (Chromium only) -->
      @if (folderAccess.hasFsAccess) {
        <button class="import-btn primary" (click)="openFolder()" type="button"
          [disabled]="opening()">
          {{ opening() ? 'Opening...' : 'Open folder' }}
        </button>
        <div style="width:0.5px;height:18px;background:var(--maple-border)"></div>
      }

      <!-- Legacy import buttons (always available as fallback / one-off imports) -->
      <button class="import-btn" (click)="filePicker.click()" type="button">
        + Import files
      </button>
      <button class="import-btn" (click)="folderPicker.click()" type="button">
        {{ folderAccess.hasFsAccess ? 'Import folder (legacy)' : 'Import folder' }}
      </button>

      @if (importing()) {
        <span class="import-status">Importing {{ pendingCount() }} file(s)...</span>
      }

      @if (openError()) {
        <span class="import-status" style="color:var(--maple-error-text)">
          {{ openError() }}
        </span>
      }

      <!-- Hidden file inputs -->
      <input #filePicker type="file" multiple
        accept=".dng,.cr2,.cr3,.nef,.arw,.raf,.orf,.rw2,.pef,.srw,.3fr,.fff,.dcr,.mos,.iiq,.mrw,.raw"
        (change)="onFileInputChange($event)">
      <input #folderPicker type="file" multiple webkitdirectory
        (change)="onFileInputChange($event)">
    </div>

    <!-- Read-only banner: shown when folder was opened without write permission -->
    @if (showReadOnlyBanner()) {
      <div class="readonly-banner">
        <span>Read-only — grant write access to save edits and cache thumbnails.</span>
        <button class="grant-btn" (click)="requestWrite()" type="button">
          Grant write access
        </button>
      </div>
    }

    <!-- Drag-over overlay -->
    @if (dragOver()) {
      <div class="drop-overlay">
        <div class="drop-box">Drop RAW files to import</div>
      </div>
    }
  `,
})
export class DropZoneComponent {
  @Output() imported = new EventEmitter<AssetId[]>();
  @Output() folderOpened = new EventEmitter<MapleFolderHandle>();

  readonly state       = inject(LibraryStateService);
  readonly folderAccess = inject(FolderAccessService);

  readonly dragOver     = signal(false);
  readonly importing    = signal(false);
  readonly pendingCount = signal(0);
  readonly opening      = signal(false);
  readonly openError    = signal<string | null>(null);

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
      const msg = err instanceof Error ? err.message : String(err);
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
      this.state.currentFolder.update(f => f ? { ...f, write: true } : f);
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
    const raws = files.filter(f => isSupportedRaw(f.name));
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
    }
  }
}
