// LandingComponent — shown at `/` in the Hosted build only.
//
// Spec §06 step 1: two CTAs ("Open a photo" and "Open a folder") with the
// Open-a-folder CTA hidden (and replaced by a small banner) on browsers that
// lack the File System Access API.

import { ChangeDetectionStrategy, Component, ElementRef, inject, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { FolderAccessService, LibraryStateService, isSupportedRaw } from '@maple-common';

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
    if (!file) return;

    if (!isSupportedRaw(file.name) && !file.type.startsWith('image/')) {
      // Silently ignore unsupported types; the <input> accept filter should
      // normally prevent this, but some browsers are lax.
      return;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const assetId = this.state.addImportedAsset(bytes, file.name);
    void this.router.navigate(['/edit', assetId]);
  }

  /** Triggered by the "Open a folder" button (Chromium only). */
  async openFolder(): Promise<void> {
    const handle = await this.fs.openFolder();
    if (!handle) return;
    await this.state.openFolder(handle);
    void this.router.navigate(['/browse']);
  }
}
