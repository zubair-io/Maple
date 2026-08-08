// Shared shape for the `[cdkDragData]` payload the asset-grid attaches to a
// dragged tile and the folder-tree reads back on drop (#2644). Lives outside
// both `asset-grid/` and `components/folder-tree/` — a plain data contract
// between two sibling components, not owned by either.

import type { AssetId } from '../models/asset';

/** Stable, readable `cdkDropList` id for the asset-grid's tile container —
 * cosmetic only (DOM inspection / debugging). Cross-list connection is NOT
 * wired through this id: `browse-shell.component.html` puts a single
 * `cdkDropListGroup` on the ancestor that wraps both the grid and the
 * folder-tree sidebar, which connects every descendant `cdkDropList`
 * automatically (#2644 review — an earlier version pointed each folder
 * row's `[cdkDropListConnectedTo]` at this id, which is backwards: CDK's
 * `connectedTo` on list A grants list A's OWN items entry into the named
 * targets, so that wiring let folder rows' empty item set enter the grid,
 * not grid tiles enter folder rows, and the drag gesture never worked). */
export const ASSET_GRID_DROP_LIST_ID = 'maple-asset-grid-drop-list';

export interface AssetDragData {
  /** The full multi-select if the dragged tile is part of it (design doc:
   * "multi-select drag carries the whole selection"); otherwise just the
   * one tile that was dragged. */
  assetIds: AssetId[];
  /** `slug:relPath` address of the folder the drag started in — every
   * dragged asset lives here, since the grid only ever shows one folder's
   * contents at a time. */
  sourceFolderId: string;
}
