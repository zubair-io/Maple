// single-file-save-notice.vm.ts — pure Hosted-workspace → toast-copy
// projection, extracted from the deleted `SingleFileSaveNoticeComponent`
// wrapper (toast sweep, ticket #3043). `HostedEditorRouteComponent` (the
// notice's sole consumer) injects the four services this used to own, feeds
// them into `noticeViewModel`, and binds the result straight into a
// `<mui-toast>`.

import type { WorkspaceMode } from '../workspace/workspace-capabilities';
import type { SingleFileXmpStatus } from '../xmp/single-file-xmp.service';

export interface SaveNoticeViewModel {
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

export const noticeViewModel = (
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
