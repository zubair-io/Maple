// HostedEditorRouteComponent — Hosted's /edit route. Composes the shared
// editor shell plus the single-file/read-only-folder save notice, which
// used to be its own `SingleFileSaveNoticeComponent` wrapper (deleted, toast
// sweep ticket #3043 — same "push the view-model into the one real
// consumer" pattern as `RootShellComponent`'s `saveState`/`updates`/
// `gpuFallback` fields). `noticeViewModel` has no single natural owning
// service (it combines workspace mode, asset focus, and XMP durability), so
// it stays a pure function this route calls directly rather than being
// grafted onto an unrelated service.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  EditorShellComponent,
  ImageExportService,
  LibraryStateService,
  MuiToastComponent,
  SingleFileXmpService,
  WORKSPACE_CAPABILITIES,
  noticeViewModel,
} from '@maple-common';

@Component({
  selector: 'maple-syrup-editor-route',
  standalone: true,
  imports: [EditorShellComponent, MuiToastComponent],
  templateUrl: './hosted-editor-route.component.html',
  styleUrl: './hosted-editor-route.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HostedEditorRouteComponent {
  private readonly state = inject(LibraryStateService);
  private readonly capabilities = inject(WORKSPACE_CAPABILITIES, { optional: true });
  private readonly exporter = inject(ImageExportService);
  private readonly singleFileXmp = inject(SingleFileXmpService);

  private readonly mode = computed(() => {
    const folder = this.state.currentFolder?.();
    const location = folder
      ? folder.write
        ? 'writable-folder'
        : 'read-only-folder'
      : 'single-file';
    return this.capabilities?.resolve(location).mode;
  });

  private readonly xmpStatus = computed(() => {
    const asset = this.state.focusedAsset();
    const status = this.singleFileXmp.status();
    return asset?.id === status.assetId ? status : null;
  });

  protected readonly notice = computed(() =>
    noticeViewModel(
      this.mode(),
      this.xmpStatus(),
      this.state.singleFileMemoryOnly?.() === true,
      this.state.focusedAsset() != null,
    ),
  );

  protected downloadXmp(): void {
    const asset = this.state.focusedAsset();
    if (!asset) return;
    this.exporter.downloadSidecar(asset);
    this.singleFileXmp.markDownloaded(asset.id);
  }
}
