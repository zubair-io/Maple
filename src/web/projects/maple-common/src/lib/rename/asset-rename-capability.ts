// AssetRenameCapability — the interface `asset-thumb`, `info-filename-row`,
// and `browse-shell` (all shared between Hosted and Self Hosted) inject
// instead of the concrete `AssetRenameService` (#2706 review /
// `check-hosted-capability-boundary.mjs`).
//
// Rename is a `POST /api/assets/:id/rename` call — a Self-Hosted-only
// capability (Hosted has no server to rename files on; see
// `AssetRenameService.disabledReason`'s doc). If the shared components
// imported `AssetRenameService` directly, its module — which imports
// `BunApiBackendService`, and through it the server-only
// `/assets/by-address` string the boundary check greps for — would end up
// in Hosted's static import graph and its bundle regardless of the runtime
// `disabledReason()` gate, because `AssetRenameService` is reachable from
// components Hosted's app.config.ts composes unconditionally.
//
// The fix mirrors `workspace/self-hosted-workspace.providers.ts`'s existing
// pattern (`SERVER_LIBRARY_IO`, `LIBRARY_SOURCE`): an `InjectionToken` whose
// default factory is a NO-OP implementation defined right here (no
// `BunApiBackendService` import), and which `provideSelfHostedWorkspace()`
// overrides with `useExisting: AssetRenameService` — so only the Self
// Hosted composition root's import graph ever reaches the real service.

import { InjectionToken, Signal, signal } from '@angular/core';
import type { Asset, AssetId } from '../models/asset';

export type RenameCollisionPolicy = 'skip' | 'replace' | 'keep-both';

export interface AssetRenameCapability {
  /** Id of the asset with a live inline-rename field, or `null`. */
  readonly editingAssetId: Signal<AssetId | null>;
  /** Server rejection for the field currently open, or `null`. */
  readonly error: Signal<string | null>;
  /** True while a commit request is in flight. */
  readonly busy: Signal<boolean>;
  /** Set when the last commit attempt collided with an existing filename. */
  readonly collision: Signal<{ assetId: AssetId; filename: string } | null>;
  /** Why rename is unavailable for `asset`, or `null` when it's allowed. */
  disabledReason(asset: Asset): string | null;
  startEditing(asset: Asset): void;
  cancel(): void;
  commit(asset: Asset, newFilename: string): void;
  resolveCollision(asset: Asset, policy: RenameCollisionPolicy): void;
}

/** Always-disabled default — every method is a no-op and `disabledReason`
 * always explains why. This is what Hosted actually gets at runtime (it
 * never overrides the token), and it's also what any Self-Hosted context
 * that hasn't composed `provideSelfHostedWorkspace()` yet (e.g. a bare
 * component test) gets absent an explicit override. */
const NOOP_CAPABILITY: AssetRenameCapability = {
  editingAssetId: signal(null),
  error: signal(null),
  busy: signal(false),
  collision: signal(null),
  disabledReason: () => 'Rename requires a Self Hosted library',
  startEditing: () => {},
  cancel: () => {},
  commit: () => {},
  resolveCollision: () => {},
};

export const ASSET_RENAME_CAPABILITY = new InjectionToken<AssetRenameCapability>(
  'ASSET_RENAME_CAPABILITY',
  { providedIn: 'root', factory: () => NOOP_CAPABILITY },
);
