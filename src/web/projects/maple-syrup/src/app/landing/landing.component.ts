// LandingComponent — shown at `/` in the Hosted build only.
//
// Spec §06 step 1: two CTAs ("Open a photo" and "Open a folder") with the
// Open-a-folder CTA hidden (and replaced by a small banner) on browsers that
// lack the File System Access API.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import {
  FolderAccessService,
  LibraryStateService,
  isSupportedRaw,
  persistFile,
} from '@maple-common';

@Component({
  selector: 'app-landing',
  standalone: true,
  templateUrl: './landing.component.html',
  styleUrl: './landing.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LandingComponent {
  private readonly router = inject(Router);
  private readonly fs = inject(FolderAccessService);
  private readonly state = inject(LibraryStateService);

  /** True when the browser exposes `showDirectoryPicker` (Chromium-only today). */
  readonly hasFsAccess = this.fs.hasFsAccess;
  readonly isDragging = signal(false);
  readonly errorMessage = signal<string | null>(null);

  /** Hidden <input type="file"> wired to the "Open a photo" CTA. */
  private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  /** Triggered by the "Open a photo" button. */
  openPhoto(): void {
    this.fileInput().nativeElement.click();
  }

  /** Triggered by the hidden file input's `change` event. */
  async onFilePicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // reset so the same file can be re-picked
    if (file) await this.openFile(file);
  }

  /** Triggered by the "Open a folder" button (Chromium only). */
  async openFolder(): Promise<void> {
    this.errorMessage.set(null);
    try {
      await this.openFolderHandle(await this.fs.openFolder());
    } catch (error) {
      this.showError('Maple could not open that folder.', error);
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.isDragging.set(true);
  }

  onDragLeave(event: DragEvent): void {
    if (event.currentTarget === event.target) this.isDragging.set(false);
  }

  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.isDragging.set(false);
    this.errorMessage.set(null);
    const transfer = event.dataTransfer;
    if (!transfer) return;

    try {
      const folder = await this.fs.openDroppedFolder(transfer);
      if (folder) {
        await this.openFolderHandle(folder);
        return;
      }

      const file = transfer.files.item(0);
      if (file) {
        await this.openFile(file);
        return;
      }
      this.errorMessage.set('Drop a supported RAW, image, or folder.');
    } catch (error) {
      this.showError('Maple could not read that dropped item.', error);
    }
  }

  private async openFile(file: File): Promise<void> {
    this.errorMessage.set(null);
    if (!isSupportedRaw(file.name) && !file.type.startsWith('image/')) {
      this.errorMessage.set(`“${file.name}” is not a supported RAW or image file.`);
      return;
    }

    try {
      const assetId = crypto.randomUUID();
      const bytes = new Uint8Array(await file.arrayBuffer());
      this.state.addImportedAsset(bytes, file.name, assetId);
      void persistFile(assetId, file).catch((error: unknown) => {
        this.showError('This photo is open, but browser storage is unavailable.', error);
      });
      this.state.selectedSourceId.set('f-imported');
      this.state.selectAsset(assetId);
      await this.router.navigate(['/edit', assetId]);
    } catch (error) {
      this.showError(`Maple could not open “${file.name}”.`, error);
    }
  }

  private async openFolderHandle(
    handle: Awaited<ReturnType<FolderAccessService['openFolder']>>,
  ): Promise<void> {
    if (!handle) return;
    await this.state.openFolder(handle);
    await this.router.navigate(['/browse']);
  }

  private showError(message: string, _error: unknown): void {
    this.errorMessage.set(message);
  }
}
