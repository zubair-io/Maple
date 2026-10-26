// The Trash panel's Empty Trash summary toast: deletions, real failures,
// photos kept because another copy exists (#5419) and items restored
// elsewhere (#2749) are each reported apart, so nothing kept or restored is
// ever counted as "Permanently deleted".

import type { MuiToastVariant } from '../ui/toast/mui-toast.component';
import type { TrashDeleteOutcome, TrashItem } from './trash.types';
import { keptCopiesNote } from './trash-kept-copy';

/** One item's purge result; `null` when the call itself failed. */
export interface EmptyTrashResult {
  item: TrashItem;
  outcome: TrashDeleteOutcome | null;
}

export function emptyTrashSummary(
  results: readonly EmptyTrashResult[],
  hadMorePages: boolean,
): { message: string; variant: MuiToastVariant } {
  const deleted = results.filter((r) => r.outcome?.kind === 'ok').length;
  const failed = results.filter((r) => r.outcome === null).length;
  const kept = results.flatMap((r) => (r.outcome?.kind === 'kept' ? [r.outcome] : []));
  const keptNames = results.filter((r) => r.outcome?.kind === 'kept').map((r) => r.item.filename);
  const restored = results
    .filter((r) => r.outcome?.kind === 'conflict')
    .map((r) => r.item.filename);

  const deletedClause =
    failed > 0
      ? `Permanently deleted ${deleted} of ${results.length} item(s) — ${failed} failed.`
      : deleted === 0 && kept.length > 0
        ? ''
        : `Permanently deleted ${deleted} item(s).`;
  const keptNote = keptCopiesNote(
    keptNames,
    kept.some((outcome) => outcome.cleanupPending),
  );
  const restoredNote =
    restored.length > 0
      ? ` ${restored.length} were restored elsewhere and not deleted (${restored.join(', ')}).`
      : '';
  const moreNote = hadMorePages
    ? ' More items remain further back in Trash — reopen Empty Trash to continue.'
    : '';
  const variant: MuiToastVariant =
    failed > 0 ? 'warning' : kept.length + restored.length > 0 ? 'info' : 'success';
  return { message: `${deletedClause}${keptNote}${restoredNote}${moreNote}`.trim(), variant };
}
