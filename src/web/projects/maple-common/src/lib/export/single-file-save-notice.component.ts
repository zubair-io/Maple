import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LibraryStateService } from '../state/library-state.service';
import { WORKSPACE_CAPABILITIES, type WorkspaceMode } from '../workspace/workspace-capabilities';
import { ImageExportService } from './image-export.service';
import { SingleFileXmpService, type SingleFileXmpStatus } from '../xmp/single-file-xmp.service';

interface SaveNoticeViewModel {
  readonly ariaLabel: 'Read-only folder save' | 'Single-file save';
  readonly message: string;
}

const MEMORY_WARNING =
  ' Browser storage is unavailable. Reloading will discard this photo session.';

const singleFileMessage = (status: SingleFileXmpStatus | null): string => {
  if (status?.unsaved) {
    return 'These edits are only in this browser session. Download the XMP to keep your latest work.';
  }
  if (status?.durability === 'paired') {
    return 'Paired XMP loaded. Download another XMP after making new edits.';
  }
  if (status?.durability === 'downloaded') {
    return 'XMP downloaded. Download it again after making new edits.';
  }
  return 'This single-file session can’t write a sibling .xmp or .maple cache. Download the XMP to keep your edits.';
};

const noticeViewModel = (
  mode: WorkspaceMode | undefined,
  status: SingleFileXmpStatus | null,
  memoryOnly: boolean,
  hasAsset: boolean,
): SaveNoticeViewModel | null => {
  if (!hasAsset) return null;
  if (mode === 'hosted-read-only-folder') {
    return {
      ariaLabel: 'Read-only folder save',
      message:
        'This folder is read-only, so Maple can’t update its sibling .xmp or .maple cache. Download the XMP to keep this edit.',
    };
  }
  if (mode !== 'hosted-single-file') return null;
  return {
    ariaLabel: 'Single-file save',
    message: `${singleFileMessage(status)}${memoryOnly ? MEMORY_WARNING : ''}`,
  };
};

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
  readonly notice = computed(() =>
    noticeViewModel(
      this.mode(),
      this.xmpStatus(),
      this.state.singleFileMemoryOnly?.() === true,
      this.state.focusedAsset() != null,
    ),
  );

  downloadXmp(): void {
    const asset = this.state.focusedAsset();
    if (!asset) return;
    this.exporter.downloadSidecar(asset);
    this.singleFileXmp.markDownloaded(asset.id);
  }
}
