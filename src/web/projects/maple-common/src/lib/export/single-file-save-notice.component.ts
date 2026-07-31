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

  readonly visible = computed(
    () =>
      this.capabilities?.resolve(this.state.currentFolder?.()?.write === true).mode ===
        'hosted-single-file' && this.state.focusedAsset() != null,
  );

  downloadXmp(): void {
    const asset = this.state.focusedAsset();
    if (asset) this.exporter.downloadSidecar(asset);
  }
}
