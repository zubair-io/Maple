// DragMoveCapability — the interface `asset-grid` and `folder-tree` (both
// shared between Hosted and Self Hosted) inject instead of the concrete
// `DragMoveService` (#2644, mirrors `rename/asset-rename-capability.ts`'s
// #2706-review pattern).
//
// Drag-move/copy is a `POST /api/assets/:id/relocate` call — a Self-Hosted-
// only capability (Hosted has no server to move files on). The drag SOURCE
// (grid tiles) and drop TARGET (folder-tree nodes) both live in components
// eagerly loaded by both apps, so — same as inline-rename — the concrete
// service (which imports `BunApiBackendService`, and through it the
// server-only relocate endpoint string the boundary check greps for) can't
// be imported directly there without dragging it into Hosted's static
// import graph. An `InjectionToken` whose default factory is a NO-OP
// implementation (defined right here, no `BunApiBackendService` import)
// solves it: `provideSelfHostedWorkspace()` overrides the token with
// `useExisting: DragMoveService`, so only the Self Hosted composition
// root's import graph ever reaches the real service.

import { InjectionToken, Signal, signal } from '@angular/core';
import type { AssetId } from '../models/asset';
import type { SidebarEntry } from '../models/folder';
import type { DragMoveMode, DragMoveSummary } from './drag-move.types';

export type DragMoveCollisionPolicy = 'skip' | 'replace' | 'keep-both';

export interface DragMoveCollisionPrompt {
  /** Filename of the item currently blocked on a collision — the dialog
   * names it so Skip/Replace/Keep Both aren't ambiguous mid-batch. */
  filename: string;
}

export interface DragMoveCapability {
  /** Whether drag-move/copy is wired up at all (`false` on Hosted, and on
   * any Self-Hosted context that hasn't composed `provideSelfHostedWorkspace()`
   * yet — e.g. a bare component test). Gates whether the grid makes tiles
   * draggable and whether the "Move to…" action is enabled. */
  readonly available: Signal<boolean>;
  /** True while the per-asset relocate queue for the current drop is
   * in flight (including paused on a collision prompt). */
  readonly busy: Signal<boolean>;
  /** Set when the item currently at the head of the queue collided with an
   * existing filename at the destination — the caller renders Skip / Replace
   * / Keep Both and calls `resolveCollision`. */
  readonly collisionPrompt: Signal<DragMoveCollisionPrompt | null>;
  /** Set once the whole queue for a drop has settled — moved/skipped counts
   * plus any per-item failures, for partial-failure reporting. */
  readonly resultSummary: Signal<DragMoveSummary | null>;
  /**
   * Why `targetNode` can't accept a drop of assets currently viewed under
   * `sourceFolderId`, or `null` when it can. Used both to gray out /
   * reject a folder-tree drop target before the drop lands (a
   * `cdkDropListEnterPredicate`) and as the disabled-reason for the
   * "Move to…" folder picker's own destination list.
   */
  dropDisabledReason(targetNode: SidebarEntry, sourceFolderId: string | null): string | null;
  /**
   * Start relocating `assetIds` (currently living under `sourceFolderId`)
   * into `targetNode`, in `mode`. No-op while a previous drop's queue is
   * still in flight, or when `dropDisabledReason` rejects the target.
   */
  beginMove(
    assetIds: AssetId[],
    sourceFolderId: string,
    targetNode: SidebarEntry,
    mode: DragMoveMode,
  ): void;
  /** Resolve the pending `collisionPrompt` and continue the queue. */
  resolveCollision(policy: DragMoveCollisionPolicy): void;
  /** Dismiss the completed-drop summary banner. */
  dismissSummary(): void;
}

/** Always-disabled default — every method is a no-op, `available` stays
 * `false`, and `dropDisabledReason` always explains why. This is what
 * Hosted actually gets at runtime. */
const NOOP_CAPABILITY: DragMoveCapability = {
  available: signal(false),
  busy: signal(false),
  collisionPrompt: signal(null),
  resultSummary: signal(null),
  dropDisabledReason: () => 'Move requires a Self Hosted library',
  beginMove: () => {},
  resolveCollision: () => {},
  dismissSummary: () => {},
};

export const DRAG_MOVE_CAPABILITY = new InjectionToken<DragMoveCapability>('DRAG_MOVE_CAPABILITY', {
  providedIn: 'root',
  factory: () => NOOP_CAPABILITY,
});
