// Shared value types for drag-to-folder-tree move/copy (#2644). Split out
// from `drag-move-capability.ts` so `drag-move-summary-banner.component.ts`
// (a plain, always-eager UI component with no server import) can depend on
// the `DragMoveSummary` shape without pulling in the capability
// token/interface file too — not load-bearing for the Hosted-bundle
// boundary the way `asset-rename-capability.ts`'s split from
// `asset-rename.service.ts` is, just keeps each file single-purpose.

import type { AssetId } from '../models/asset';

export type DragMoveMode = 'move' | 'copy';

/** One asset the relocate queue gave up on after a non-collision failure
 * (network error, server 500, etc.) — reported in the summary rather than
 * rolling back the assets that already succeeded (design doc: batch
 * operations report partial failure, they don't roll back). */
export interface DragMoveItemFailure {
  assetId: AssetId;
  filename: string;
  reason: string;
}

/** Per-drop outcome, surfaced once the whole per-asset queue has settled. */
export interface DragMoveSummary {
  mode: DragMoveMode;
  /** Display label of the folder-tree node the assets were dropped on. */
  targetLabel: string;
  total: number;
  moved: number;
  /** Assets the user chose "Skip" for on a collision — not a failure. */
  skipped: number;
  failed: DragMoveItemFailure[];
}
