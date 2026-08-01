import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LibraryStateService } from '../state/library-state.service';
import { WORKSPACE_CAPABILITIES } from '../workspace/workspace-capabilities';
import { ImageExportService } from './image-export.service';

@Component({
  selector: 'maple-single-file-save-notice',
  standalone: true,
  templateUrl: './single-file-save-notice.component.html',
  styleUrl: './single-file-save-notice.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SingleFileSaveNoticeComponent {
  private readonly state = inject(LibraryStateService);
  private readonly capabilities = inject(WORKSPACE_CAPABILITIES, { optional: true });
  private readonly exporter = inject(ImageExportService);

  readonly mode = computed(() => {
    const folder = this.state.currentFolder?.();
    const location = folder
      ? folder.write
        ? 'writable-folder'
        : 'read-only-folder'
      : 'single-file';
    return this.capabilities?.resolve(location).mode;
  });
  readonly memoryOnly = computed(() => this.state.singleFileMemoryOnly?.() === true);
  readonly visible = computed(() => {
    const mode = this.mode();
    return (
      (mode === 'hosted-single-file' || mode === 'hosted-read-only-folder') &&
      this.state.focusedAsset() != null
    );
  });

  downloadXmp(): void {
    const asset = this.state.focusedAsset();
    if (asset) this.exporter.downloadSidecar(asset);
  }
}
