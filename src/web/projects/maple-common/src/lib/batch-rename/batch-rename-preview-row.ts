// batch-rename-preview-row.ts — normalizes both the dry-run preview items
// (`BatchRenamePreviewItem`, shown while editing) and the applied results
// (`BatchRenameItemResult`, shown after Apply) into one row shape so
// `BatchRenamePreviewListComponent` only ever has to render ONE template,
// not two near-identical ones. Pure functions — no Angular deps — so they're
// trivially unit-testable and keep `BatchRenameFormComponent`/
// `BatchRenameResultsComponent`'s own templates down to "map then render a
// list," which is what actually fixed fallow's template-complexity finding
// (the single combined dialog template was CRITICAL: 27 cyclomatic / 47
// cognitive / 201 lines).

import type { BatchRenameItemResult, BatchRenamePreviewItem } from './batch-rename.types';

export interface BatchRenamePreviewBadge {
  label: string;
  kind: 'success' | 'warning';
}

export interface BatchRenamePreviewRowVm {
  key: string;
  isError: boolean;
  oldText: string;
  newText: string;
  badge: BatchRenamePreviewBadge | null;
}

export function previewItemToRow(item: BatchRenamePreviewItem): BatchRenamePreviewRowVm {
  if (item.error) {
    return {
      key: item.address,
      isError: true,
      oldText: item.oldFilename ?? '—',
      newText: item.error,
      badge: null,
    };
  }
  return {
    key: item.address,
    isError: false,
    oldText: item.oldFilename ?? '—',
    newText: item.newFilename ?? '',
    badge: item.duplicate ? { label: 'duplicate', kind: 'warning' } : null,
  };
}

function relocatedRow(
  item: Extract<BatchRenameItemResult, { kind: 'relocated' }>,
): BatchRenamePreviewRowVm {
  return {
    key: item.address,
    isError: false,
    oldText: item.oldFilename,
    newText: item.newFilename,
    badge: { label: 'renamed', kind: 'success' },
  };
}

function skippedRow(
  item: Extract<BatchRenameItemResult, { kind: 'skipped' }>,
): BatchRenamePreviewRowVm {
  return {
    key: item.address,
    isError: true,
    oldText: item.address,
    newText: `skipped: ${item.reason}`,
    badge: null,
  };
}

function notFoundRow(
  item: Extract<BatchRenameItemResult, { kind: 'not-found' }>,
): BatchRenamePreviewRowVm {
  return {
    key: item.address,
    isError: true,
    oldText: item.address,
    newText: 'not found',
    badge: null,
  };
}

function failedRow(
  item: Extract<BatchRenameItemResult, { kind: 'invalid' | 'error' }>,
): BatchRenamePreviewRowVm {
  return {
    key: item.address,
    isError: true,
    oldText: item.address,
    newText: item.error,
    badge: null,
  };
}

export function applyResultToRow(item: BatchRenameItemResult): BatchRenamePreviewRowVm {
  switch (item.kind) {
    case 'relocated':
      return relocatedRow(item);
    case 'skipped':
      return skippedRow(item);
    case 'not-found':
      return notFoundRow(item);
    case 'invalid':
    case 'error':
      return failedRow(item);
  }
}
