// Shared value types for the Trash pseudo-node (#2652). Split out from
// `trash-capability.ts` the same way `drag-move.types.ts` is split from
// `drag-move-capability.ts` — a plain, no-server-import shape file so UI
// components can depend on it without pulling in the capability
// token/interface too.

import type { AssetId } from '../models/asset';

/** One trashed asset, as listed by `GET /api/folders/:id/trash` — mirrors
 * the server's per-item response shape (`routes/folders.ts`). */
export interface TrashItem {
  assetId: AssetId;
  filename: string;
  originalRelativePath: string;
  trashRelativePath: string;
  size: number;
  mtime: string;
  deletedAt: string;
}

/** One page of `GET /api/folders/:id/trash`. */
export interface TrashPage {
  items: TrashItem[];
  nextCursor: string | null;
}

/** `POST /api/assets/:id/restore`'s success body — `renamedTo` is set when
 * `pickFreeRestoredPath` had to suffix the filename to avoid a collision at
 * the destination, so the caller can report the real outcome instead of a
 * generic "restored" (the file-management design's collision-safe restore
 * contract: renames are reported, never collapsed to silent success). */
export interface RestoreAssetResult {
  assetId: AssetId;
  absPath: string;
  filename: string;
  size: number;
  mtime: string;
  renamedTo: string | null;
}

/** One asset's outcome within a recursive folder trash/restore batch —
 * mirrors the server's `FolderBatchItemResult` (`library/folder-trash.ts`). */
export interface TrashBatchItem {
  assetId: AssetId;
  filename: string;
  ok: boolean;
  error?: string;
}

/** Mirrors the server's `FolderBatchSummary` — a partial-failure batch
 * summary, not a single pass/fail (same contract `DragMoveSummary` and
 * `FolderTrashSummary` (`api/folder-crud.service.ts`) already use). */
export interface TrashBatchSummary {
  total: number;
  succeeded: number;
  failed: number;
  items: TrashBatchItem[];
}

/** `TrashApiService.deleteAsset`'s per-call outcome (#2749). A 409 from the
 * server means the caller's `intent` didn't match the asset's actual
 * state — its listing was stale — and is a distinct, expected outcome, not
 * a generic HTTP failure: `state: 'trashed'` on an `intent: 'trash'` call
 * means it's already in Trash (someone else trashed it first); `state:
 * 'live'` on an `intent: 'purge'` call means it was restored elsewhere
 * before this purge landed. `state` can be `null` if the server ever omits
 * it (defensive — every 409 `routes/assets/trash.ts` sends today includes
 * it). */
export type TrashDeleteOutcome =
  | { kind: 'ok' }
  | { kind: 'conflict'; state: 'trashed' | 'live' | null };

/** One asset that did NOT end up trashed from a grid multi-select
 * (`TrashCapability.trashAssets`) — either a real failure, or a benign
 * `intent=trash` 409 (`alreadyTrashed: true`, someone else trashed it
 * first — same partial-failure shape `DragMoveItemFailure` uses for the
 * drag-move queue, extended with the conflict case). */
export interface TrashItemFailure {
  assetId: AssetId;
  filename: string;
  reason: string;
  /** True for the benign "someone else already trashed this" 409 — the
   * caller should NOT report this as a failure the way a network/500 error
   * is reported. */
  alreadyTrashed?: boolean;
}

/** Outcome of a `trashAssets` batch, surfaced once the whole queue settles. */
export interface TrashAssetsSummary {
  total: number;
  trashed: number;
  failed: TrashItemFailure[];
}

/** How many items are currently in a library's Trash, for the sidebar
 * badge. `capped` is true when the server's page (`listTrash`'s
 * `TRASH_COUNT_PAGE_SIZE`) filled up and a `nextCursor` remained — the
 * badge then reads e.g. "100+" rather than claiming an exact count it
 * didn't actually verify. */
export interface TrashCount {
  count: number;
  capped: boolean;
}
