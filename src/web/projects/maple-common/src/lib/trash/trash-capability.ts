// TrashCapability — the interface `folder-tree` and `asset-grid` (both
// shared between Hosted and Self Hosted) inject instead of the concrete
// `TrashService` (#2652, same shape as `drag-move/drag-move-capability.ts`
// and `rename/asset-rename-capability.ts`).
//
// Trash is a `GET/POST/DELETE /api/{assets,folders}/...` surface — a
// Self-Hosted-only capability (Hosted has no server to move files on). An
// `InjectionToken` whose default factory is a NO-OP implementation (defined
// right here, no `BunApiBackendService`/`TrashApiService` import) solves it:
// `provideSelfHostedWorkspace()` overrides the token with
// `useExisting: TrashService`, so only the Self Hosted composition root's
// import graph ever reaches the real service — the same indirection that
// keeps `DragMoveService` out of Hosted's static bundle.

import { InjectionToken, Signal, signal } from '@angular/core';
import type { AssetId } from '../models/asset';
import type { TrashAssetsSummary, TrashCount } from './trash.types';

export interface TrashCapability {
  /** Whether Trash is wired up at all (`false` on Hosted, and on any
   * Self-Hosted context that hasn't composed `provideSelfHostedWorkspace()`
   * yet). Gates whether the folder-tree renders a Trash node and whether
   * the grid toolbar's "Move to Trash" action does anything. (A Delete-key
   * shortcut on the grid is tracked separately — #2752 — and not wired up
   * yet; `trashAssets` below is ready for it.) */
  readonly available: Signal<boolean>;

  /** Per-library trashed-item counts, for the sidebar Trash node's badge.
   * Populated lazily by `ensureCountLoaded` — a library the tree hasn't
   * rendered yet, or the badge hasn't needed, has no entry. */
  readonly countByLibrary: Signal<Readonly<Record<string, TrashCount>>>;
  /** Fetch (or refresh) `libraryId`'s trash count if it isn't already
   * loaded. Idempotent per render pass — safe to call from a template or an
   * effect that reruns on every change-detection tick. */
  ensureCountLoaded(libraryId: string): void;

  /** Open the Trash panel for `libraryId` (labeled `libraryLabel` in the
   * panel header). The panel component itself is mounted only from a
   * Self-Hosted-only host (`self-hosted-browse-content.component.ts`) that
   * reads this service's panel-state signals directly — the eager
   * folder-tree row that calls `open` never references the panel
   * component, so it never pulls the panel's code into any shared chunk. */
  open(libraryId: string, libraryLabel: string): void;

  /** True while a grid multi-select "send to Trash" queue is in flight. */
  readonly busy: Signal<boolean>;
  /** Set once a `trashAssets` queue has settled — partial-failure summary,
   * same contract `DragMoveSummary` uses. */
  readonly resultSummary: Signal<TrashAssetsSummary | null>;
  /** Send `assetIds` (currently viewed under `sourceFolderId`) to Trash —
   * the grid's "Move to Trash" toolbar action calls this today; a Delete-
   * key shortcut (#2752, not yet implemented) will call the same method
   * once it lands. `folderIds` (#2976) additionally sends whole grid
   * sub-folders to Trash via `POST /folders/:id/trash-folder` (recursive,
   * reversible via the Trash panel's folder restore), reported in the same
   * summary. No-op while a previous batch is still in flight. */
  trashAssets(assetIds: AssetId[], sourceFolderId: string, folderIds?: string[]): void;
  /** Dismiss the completed-batch summary banner. */
  dismissSummary(): void;
}

/** Always-disabled default — every method is a no-op, `available` stays
 * `false`. This is what Hosted actually gets at runtime. */
const NOOP_CAPABILITY: TrashCapability = {
  available: signal(false),
  countByLibrary: signal({}),
  ensureCountLoaded: () => {},
  open: () => {},
  busy: signal(false),
  resultSummary: signal(null),
  trashAssets: () => {},
  dismissSummary: () => {},
};

export const TRASH_CAPABILITY = new InjectionToken<TrashCapability>('TRASH_CAPABILITY', {
  providedIn: 'root',
  factory: () => NOOP_CAPABILITY,
});
