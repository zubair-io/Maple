// DropZoneComponent — accepts RAW files via drag-drop or click-to-pick.
// Imported files land in the "Imported" virtual folder in LibraryStateService.

import {
  Component,
  EventEmitter,
  HostListener,
  Output,
  inject,
  signal,
} from '@angular/core';
import { LibraryStateService, isSupportedRaw, AssetId } from '@maple-common';

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

    .import-status {
      font-family: var(--maple-font);
      font-size: 11px;
      color: var(--maple-text-muted);
    }

    /* Hidden file inputs */
    input[type=file] { display: none; }
  `],
  template: `
    <!-- Import toolbar row -->
    <div class="import-bar">
      <button class="import-btn" (click)="filePicker.click()" type="button">
        + Import files
      </button>
      <button class="import-btn" (click)="folderPicker.click()" type="button">
        + Import folder
      </button>

      @if (importing()) {
        <span class="import-status">Importing {{ pendingCount() }} file(s)...</span>
      }

      <!-- Hidden file inputs -->
      <input #filePicker type="file" multiple
        accept=".dng,.cr2,.cr3,.nef,.arw,.raf,.orf,.rw2,.pef,.srw,.3fr,.fff,.dcr,.mos,.iiq,.mrw,.raw"
        (change)="onFileInputChange($event)">
      <input #folderPicker type="file" multiple webkitdirectory
        (change)="onFileInputChange($event)">
    </div>

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

  private state = inject(LibraryStateService);

  readonly dragOver  = signal(false);
  readonly importing = signal(false);
  readonly pendingCount = signal(0);

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
    // Only hide when leaving the window completely.
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
    input.value = ''; // reset so the same file can be re-picked
  }

  // ── Core import logic ──────────────────────────────────────────────────

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
      // Switch to the Imported folder and select first imported asset.
      this.state.selectedSourceId.set('f-imported');
      this.state.selectAsset(ids[0]);
      this.imported.emit(ids);
    }
  }
}
