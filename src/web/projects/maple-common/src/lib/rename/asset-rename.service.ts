// AssetRenameService — inline single-asset rename orchestration (#2637).
//
// Shared editing state so a rename can be started from any of the design
// doc's entry points (double-click the filename in a grid cell or the Info
// panel, or F2 on the focused asset) and rendered by whichever host happens
// to have that asset mounted — only one `<app-inline-rename-field>` is ever
// live at a time, keyed off `editingAssetId`.
//
// Talks to `POST /api/assets/:id/rename` (BunApiBackendService.renameAsset)
// and, on success, repoints local state via `LibraryStateService.renameAsset`
// — the client does no filename validation beyond a light UX pre-check
// (`disabledReason`); the server's shared Rust engine is authoritative (see
// rename.ts's module doc on the API side).
//
// Collisions: the request always starts with `collision: 'skip'`, so a
// same-name conflict comes back as a `'skipped'` outcome with
// `reason: 'collision'` rather than silently overwriting or auto-suffixing.
// That surfaces inline as Skip / Replace / Keep Both next to the field
// (`collision` signal) — reusing the same three-way choice the design doc
// specifies for drag-and-drop collisions, just inline instead of a modal,
// per #2637's "surface server rejections inline next to the field".
//
// NOT injected directly by shared components (`asset-thumb`,
// `info-filename-row`, `browse-shell`) — they depend on the
// `AssetRenameCapability` interface / `ASSET_RENAME_CAPABILITY` token
// instead (`asset-rename-capability.ts`). Importing this class only from
// `provideSelfHostedWorkspace()` and the Self Hosted app is what keeps
// `BunApiBackendService` — and the server-only endpoint strings inside it —
// out of Hosted's static bundle. See that file's module doc for the "why".

import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Asset, AssetId } from '../models/asset';
import {
  BunApiBackendService,
  ApiCollisionPolicy,
  ApiRenamedResult,
} from '../api/bun-api-backend.service';
import { LibraryStateService } from '../state/library-state.service';
import { formatAddress, parseAddress } from '../addressing/maple-address';
import { editRouteCommands, viewRouteCommands } from '../addressing/route-address';
import { errorMessage } from '../util/errors';
import type { AssetRenameCapability } from './asset-rename-capability';

@Injectable({ providedIn: 'root' })
export class AssetRenameService implements AssetRenameCapability {
  private readonly api = inject(BunApiBackendService);
  private readonly state = inject(LibraryStateService);
  private readonly router = inject(Router);

  /** Id of the asset with a live inline-rename field, or `null`. Only one
   * field is ever open at once — starting a new one implicitly cancels
   * whichever was open before. */
  readonly editingAssetId = signal<AssetId | null>(null);

  /** Server rejection for the field currently open (e.g. a reserved
   * Windows name) — rendered inline, not as a toast. Cleared on every new
   * attempt. */
  readonly error = signal<string | null>(null);

  /** True while a commit request is in flight. */
  readonly busy = signal(false);

  /** Set when the last commit attempt collided with an existing filename —
   * the field swaps its input for Skip / Replace / Keep Both. */
  readonly collision = signal<{ assetId: AssetId; filename: string } | null>(null);

  /**
   * Whether rename is available for `asset` at all, and why not when it
   * isn't. Rename is a Self Hosted API call (`POST /api/assets/:id/rename`)
   * — there is no local file-write path for the Hosted (File System
   * Access) backend, and an asset with no `slug:relPath` address (a
   * memory-only single-file session) has nothing on the server to rename.
   *
   * `fs:` ids contain a colon too but are NOT `slug:relPath` addresses —
   * they're the legacy FS-walk cold-load scheme (see `absPathFor`'s doc on
   * `LibraryStore` and the sidecar-restore gate, both of which explicitly
   * exclude `fs:` from "is an address"). `_applyRenamed` below assumes real
   * `slug:relPath` shape when it mints the post-rename id, so an `fs:` asset
   * must be excluded here too (#2706 review) rather than silently building
   * a bogus id.
   */
  disabledReason(asset: Asset): string | null {
    if (this.state.backend !== 'self-hosted') {
      return 'Rename requires a Self Hosted library';
    }
    if (!asset.id.includes(':') || asset.id.startsWith('fs:')) {
      return 'This asset has no server-managed location to rename';
    }
    return null;
  }

  /** Open the inline field for `asset`. No-op if renaming is disabled, or
   * if a previous rename request is still in flight (#2706 review) — letting
   * a new field open mid-request would let that older request's completion
   * mutate `busy`/`error`/`collision` (and call `cancel()`) out from under
   * the field the user just opened. `_send`'s generation token is a second,
   * independent guard against the same race for any path that reaches it
   * despite this check (e.g. two rapid F2s racing the signal read). */
  startEditing(asset: Asset): void {
    if (this.busy() || this.disabledReason(asset)) return;
    this.error.set(null);
    this.collision.set(null);
    this.editingAssetId.set(asset.id);
  }

  /** Close the field without committing anything. Also bumps
   * `_requestGeneration` (#2706 review) so a request already in flight when
   * `cancel()` fires — e.g. Escape pressed mid-request, which isn't gated
   * behind `busy()` the way the button controls are — can't land its
   * response against a field the user already walked away from. */
  cancel(): void {
    this._requestGeneration++;
    this.editingAssetId.set(null);
    this.error.set(null);
    this.collision.set(null);
    this.busy.set(false);
  }

  /**
   * Commit `newFilename` for `asset`. A no-op (silent cancel) when the
   * trimmed name is empty or unchanged — that's a cancel, not a rename.
   * Also a no-op while a previous request is still in flight (#2706 review):
   * Enter and the blur-driven commit from `InlineRenameFieldComponent` can
   * both fire for the same keystroke, and `_send` has no business issuing a
   * second request before the first one resolves.
   */
  commit(asset: Asset, newFilename: string): void {
    if (this.busy()) return;
    const trimmed = newFilename.trim();
    if (trimmed === '' || trimmed === asset.filename) {
      this.cancel();
      return;
    }
    this._send(asset, trimmed, 'skip');
  }

  /**
   * Resolve a pending collision for `asset` with the user's choice.
   * `'skip'` here means "give up" — same as cancelling the field.
   */
  resolveCollision(asset: Asset, policy: Exclude<ApiCollisionPolicy, 'auto-suffix'>): void {
    if (this.busy()) return;
    const pending = this.collision();
    if (!pending || pending.assetId !== asset.id) return;
    if (policy === 'skip') {
      this.cancel();
      return;
    }
    this.collision.set(null);
    this._send(asset, pending.filename, policy);
  }

  /** Bumped on every `_send` call; a request's callbacks only apply their
   * result if this still matches the token they captured. Belt-and-braces
   * against the `busy()` guards above (#2706 review): those stop the
   * common paths from ever issuing a second request while one is in
   * flight, but this token is what actually makes a stale response inert
   * if one somehow gets through — e.g. `cancel()` resets `busy` to `false`
   * without waiting for the in-flight request, so a `startEditing` on a
   * DIFFERENT asset right after a cancel must not let the abandoned
   * request's later response mutate the new field's state. */
  private _requestGeneration = 0;

  private _send(asset: Asset, filename: string, collision: ApiCollisionPolicy): void {
    const generation = ++this._requestGeneration;
    this.busy.set(true);
    this.error.set(null);
    const wasFocused = this.state.focusedAssetId() === asset.id;
    const currentUrl = this.router.url;
    this.api.renameAsset(asset.id, filename, collision).subscribe({
      next: (outcome) => {
        if (generation !== this._requestGeneration) return;
        this.busy.set(false);
        if (outcome.kind === 'skipped') {
          if (outcome.reason === 'collision') {
            this.collision.set({ assetId: asset.id, filename });
            return;
          }
          // Any other skip (e.g. "already at destination") is a no-op.
          this.cancel();
          return;
        }
        this._applyRenamed(asset, outcome, wasFocused, currentUrl);
        this.cancel();
      },
      error: (err) => {
        if (generation !== this._requestGeneration) return;
        this.busy.set(false);
        this.error.set(errorMessage(err));
      },
    });
  }

  private _applyRenamed(
    asset: Asset,
    outcome: ApiRenamedResult,
    wasFocused: boolean,
    currentUrl: string,
  ): void {
    const oldAddr = parseAddress(asset.id);
    const newId = formatAddress({
      slug: oldAddr.slug,
      relPath:
        outcome.newPath === '' ? outcome.newFilename : `${outcome.newPath}/${outcome.newFilename}`,
    });
    this.state.renameAsset(asset.id, newId, outcome.newFilename);

    // Follow the rename in an open editor/preview route so a reload of the
    // same tab doesn't 404 on the stale address. Only when the renamed
    // asset was actually the one focused/open — a rename fired from a grid
    // cell that isn't the current route target must not navigate anything.
    if (!wasFocused) return;
    if (currentUrl.startsWith('/edit/')) {
      void this.router.navigate(editRouteCommands(newId), { replaceUrl: true });
    } else if (currentUrl.startsWith('/view/')) {
      void this.router.navigate(viewRouteCommands(newId), { replaceUrl: true });
    }
  }
}
