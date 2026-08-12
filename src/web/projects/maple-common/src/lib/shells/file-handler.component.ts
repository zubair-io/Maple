// file-handler.component.ts — PWA `file_handlers` landing route (#2798).
//
// Landing route for the manifest `file_handlers` entry: when the installed
// PWA is chosen from the OS "Open with" menu for a registered RAW type,
// Chromium navigates a PWA window to `/open-file` and delivers the picked
// files through `window.launchQueue`. Params are buffered by the browser
// until a consumer is registered, so registering in ngOnInit is race-free.
//
// The files flow through the same in-memory import path a loose file drop
// uses (DropZoneComponent.importFiles): read bytes → addImportedAsset →
// select in the transient `f-imported` source → editor for a single file,
// Browse for several. The manifest registers exactly the extensions
// `isSupportedRaw` accepts (guarded by a spec on the maple side), so a
// delivered file that still fails the filter is the OS mis-routing, not a
// registration drift — it falls back to /library rather than erroring.
//
// Web counterpart of the Apple CFBundleDocumentTypes claims (#2796) and the
// Windows FileTypeRegistrar (#2797). Chromium-only, installed-PWA-only by
// platform design; a manual navigation to /open-file (no launch, so the
// consumer never fires) leaves via a grace timer instead of hanging.

import {
  ChangeDetectionStrategy,
  Component,
  inject,
  NgZone,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { Router } from '@angular/router';

import { LibraryStateService, isSupportedRaw } from '../state/library-state.service';
import { AssetId } from '../models/asset';
import { editRouteCommands } from '../addressing/route-address';

/** Minimal typings for the File Handling API (not in TS's dom lib yet). */
interface LaunchParams {
  readonly files: ReadonlyArray<FileSystemFileHandle>;
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

/** How long a manually-navigated /open-file (no launch → the consumer never
 * fires) shows "Opening…" before leaving for /library. */
const NO_LAUNCH_GRACE_MS = 2000;

@Component({
  selector: 'app-file-handler',
  standalone: true,
  template: `<p>Opening file in Maple…</p>`,
  styles: [
    `
      :host {
        display: block;
        padding: 24px;
        color: var(--mpl-text-secondary, #a8a29e);
        font-size: 13px;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FileHandlerComponent implements OnInit, OnDestroy {
  private readonly state = inject(LibraryStateService);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);

  private fallbackTimer: ReturnType<typeof setTimeout> | undefined;

  ngOnInit(): void {
    const queue = (window as { launchQueue?: LaunchQueue }).launchQueue;
    if (!queue?.setConsumer) {
      // Not a file-handling-capable browser (or not launched as one) —
      // nothing will ever arrive here.
      void this.router.navigate(['/library'], { replaceUrl: true });
      return;
    }
    this.fallbackTimer = setTimeout(
      () => void this.router.navigate(['/library'], { replaceUrl: true }),
      NO_LAUNCH_GRACE_MS,
    );
    // The consumer callback comes from the browser, outside Angular's zone —
    // re-enter so the import's signal writes and the navigation are picked up.
    queue.setConsumer((params) => this.zone.run(() => void this.consume(params)));
  }

  ngOnDestroy(): void {
    clearTimeout(this.fallbackTimer);
  }

  private async consume(params: LaunchParams): Promise<void> {
    clearTimeout(this.fallbackTimer);
    const files: File[] = [];
    for (const handle of params.files ?? []) {
      try {
        files.push(await handle.getFile());
      } catch (err) {
        console.error('FileHandlerComponent: getFile failed', err);
      }
    }
    const raws = files.filter((f) => isSupportedRaw(f.name));
    if (raws.length === 0) {
      void this.router.navigate(['/library'], { replaceUrl: true });
      return;
    }

    const ids: AssetId[] = [];
    for (const file of raws) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        ids.push(this.state.addImportedAsset(bytes, file.name));
      } catch (err) {
        console.error(`FileHandlerComponent: failed to read ${file.name}`, err);
      }
    }
    if (ids.length === 0) {
      void this.router.navigate(['/library'], { replaceUrl: true });
      return;
    }

    this.state.selectedSourceId.set('f-imported');
    this.state.selectAsset(ids[0]);
    // Single file → straight into the editor, the same destination an OS
    // open lands on for the Apple/Windows shells; several → Browse, which
    // already shows the imported source's contents.
    if (ids.length === 1) {
      void this.router.navigate(editRouteCommands(ids[0]), { replaceUrl: true });
    } else {
      void this.router.navigate(['/library'], { replaceUrl: true });
    }
  }
}
