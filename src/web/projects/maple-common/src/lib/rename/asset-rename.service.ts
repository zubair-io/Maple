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

@Injectable({ providedIn: 'root' })
export class AssetRenameService {
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
   */
  disabledReason(asset: Asset): string | null {
    if (this.state.backend !== 'self-hosted') {
      return 'Rename requires a Self Hosted library';
    }
    if (!asset.id.includes(':')) {
      return 'This asset has no server-managed location to rename';
    }
    return null;
  }

  /** Open the inline field for `asset`. No-op if renaming is disabled. */
  startEditing(asset: Asset): void {
    if (this.disabledReason(asset)) return;
    this.error.set(null);
    this.collision.set(null);
    this.busy.set(false);
    this.editingAssetId.set(asset.id);
  }

  /** Close the field without committing anything. */
  cancel(): void {
    this.editingAssetId.set(null);
    this.error.set(null);
    this.collision.set(null);
    this.busy.set(false);
  }

  /**
   * Commit `newFilename` for `asset`. A no-op (silent cancel) when the
   * trimmed name is empty or unchanged — that's a cancel, not a rename.
   */
  commit(asset: Asset, newFilename: string): void {
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
    const pending = this.collision();
    if (!pending || pending.assetId !== asset.id) return;
    if (policy === 'skip') {
      this.cancel();
      return;
    }
    this.collision.set(null);
    this._send(asset, pending.filename, policy);
  }

  private _send(asset: Asset, filename: string, collision: ApiCollisionPolicy): void {
    this.busy.set(true);
    this.error.set(null);
    const wasFocused = this.state.focusedAssetId() === asset.id;
    const currentUrl = this.router.url;
    this.api.renameAsset(asset.id, filename, collision).subscribe({
      next: (outcome) => {
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
