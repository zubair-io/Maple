// BATCH_RENAME_ENABLED — whether the "Batch Rename…" action (#2640) is
// available. Batch rename is a `POST /api/assets/batch-rename[/preview]`
// call — a Self-Hosted-only capability, same rationale as
// `FOLDER_TREE_CRUD_ENABLED` (`folder-tree-crud-capability.ts`) and
// `ASSET_RENAME_CAPABILITY` (`rename/asset-rename-capability.ts`): Hosted
// has no server to rename files on, so this defaults to `false` and only
// Self Hosted's composition root turns it on.
//
// The dialog component itself (`BatchRenameDialogComponent`) is referenced
// only inside an `@defer` block in its (Self-Hosted-only) host, so this
// token gates the trigger, not a static import graph — but it stays a real
// `InjectionToken` rather than a hard-coded `false` so the trigger's
// disabled/hidden state is driven by the same composition-root switch as
// every other File Management capability, and so a future shared entry
// point (e.g. a grid multi-select context menu reachable from Hosted too)
// can gate on it without introducing a second mechanism.

import { InjectionToken, Provider } from '@angular/core';

export const BATCH_RENAME_ENABLED = new InjectionToken<boolean>('BATCH_RENAME_ENABLED', {
  providedIn: 'root',
  factory: () => false,
});

export function provideBatchRename(): Provider {
  return { provide: BATCH_RENAME_ENABLED, useValue: true };
}
