// Shared shape for the `[cdkDragData]` payload the asset-grid attaches to a
// dragged tile and the folder-tree reads back on drop (#2644). Lives outside
// both `asset-grid/` and `components/folder-tree/` — a plain data contract
// between two sibling components, not owned by either.

import type { AssetId } from '../models/asset';

/** The `cdkDropList` id every draggable grid tile's ancestor drop-list
 * shares, and every folder-tree row's `cdkDropListConnectedTo` points at —
 * the string CDK's app-wide `DragDropRegistry` uses to link a drag source
 * to a cross-list drop target. */
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
