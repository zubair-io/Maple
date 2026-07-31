// XmpAdjustmentRestoreService — read the XMP sidecar back into the store
// when a Self-Hosted asset becomes focused (#2406).
//
// The reload/deep-link hydration paths (`hydrateSelfHostedFsAsset`,
// `_applyFolderListing`, `addImportedAsset`) build Asset records without ever
// reading the sidecar, so a cold `/edit/<slug>/<path>` load rendered every
// adjustment at defaults — the only sidecar reader was the Hosted
// folder-picker flow (`openFolder`). This service closes that gap: an effect
// on the focused asset fetches the sidecar lazily (one small GET per focused
// asset — never N fetches for a folder listing), parses it through the real
// `XmpParserService`, and populates `LibraryStore.adjustmentModels`.
//
// Race rules:
//   - Once per asset per session (`_attempted`); a transient network failure
//     re-arms so a refocus retries, a 404 (no sidecar) does not.
//   - `LibraryStore.restoreAdjustment` refuses to overwrite an asset the
//     user has edited this session, so a late-arriving response can never
//     clobber live edits.
//
// Hosted (FS Access) is out of scope by design: after a reload no folder
// handle survives, so there is nothing to read the sidecar from — the guard
// below skips gracefully. Hosted restore continues to happen in
// `openFolder()` when the user re-picks the folder.

import { Injectable, effect, inject, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { BunApiBackendService } from '../api/bun-api-backend.service';
import type { AssetId } from '../models/asset';
import { LibraryStore } from '../state/library-store.service';
import { LibrarySelection } from '../state/library-selection.service';
import { XmpParserService } from './xmp-parser.service';
import { XmpStoreService } from './xmp-store.service';

@Injectable({ providedIn: 'root' })
export class XmpAdjustmentRestoreService {
  private readonly store = inject(LibraryStore);
  private readonly selection = inject(LibrarySelection);
  private readonly api = inject(BunApiBackendService);
  private readonly parser = inject(XmpParserService);
  private readonly xmpStore = inject(XmpStoreService);

  /** Asset ids already fetched (or in flight) this session. */
  private readonly _attempted = new Set<AssetId>();

  /** Memoized cold-start `listFolders` load (see `_ensureRegisteredFolders`). */
  private _foldersLoad: Promise<void> | null = null;

  constructor() {
    effect(() => {
      const id = this.selection.focusedAssetId();
      if (id) untracked(() => void this.restoreForAsset(id));
    });
  }

  /**
   * Restore the persisted adjustment model for `id` from its `.xmp` sidecar.
   * No-op for Hosted, non-address ids, already-attempted assets, and assets
   * whose sidecar 404s (defaults are correct then).
   */
  async restoreForAsset(id: AssetId): Promise<void> {
    if (!this._eligible(id)) return;
    this._attempted.add(id);
    try {
      const xml = await this._fetchSidecarXml(id);
      if (xml !== null) this._applyParsedSidecar(id, xml);
    } catch (err) {
      this._onFetchError(id, err);
    }
  }

  /** Self-Hosted `slug:relPath` assets not yet attempted this session. */
  private _eligible(id: AssetId): boolean {
    return (
      this.store.backend === 'self-hosted' &&
      id.includes(':') &&
      !id.startsWith('fs:') &&
      !this._attempted.has(id)
    );
  }

  /** The sidecar XML for `id`, or `null` when no library root owns its slug.
   *  Awaits the GET explicitly (rather than returning the bare promise) so
   *  this resolves after the same number of microtask turns as the inline
   *  version it replaced — returning an un-awaited promise from an `async`
   *  function costs one extra tick for the runtime to adopt it, which is
   *  enough to land after a test's fixed number of `flushAsync` turns. */
  private async _fetchSidecarXml(id: AssetId): Promise<string | null> {
    await this._ensureRegisteredFolders();
    const absPath = this.store.absPathFor(id);
    if (!absPath) return null;
    return await firstValueFrom(this.api.getXmp(absPath));
  }

  private _applyParsedSidecar(id: AssetId, xml: string): void {
    const { model, passthrough } = this.parser.parseAdjustmentModel(xml);
    // Keep the passthrough bucket so a later write round-trips unknown
    // fields byte-for-byte — same contract as the openFolder() load.
    this.xmpStore.rememberPassthrough(id, passthrough);
    this.store.restoreAdjustment(id, model);
    // A 200 means a sidecar exists on disk — flip `edited` even when
    // `restoreAdjustment` refused to overwrite (the user edited while the
    // GET was in flight). The "Edited" filter chip tracks sidecar
    // EXISTENCE, and `openFolder()` sets the flag on every successful
    // sidecar read regardless of the model's content.
    this._markEdited(id);
  }

  private _onFetchError(id: AssetId, err: unknown): void {
    if (err instanceof HttpErrorResponse && err.status === 404) return; // no sidecar — defaults stand
    // Transient failure (network, 5xx): re-arm so a refocus can retry.
    this._attempted.delete(id);
    console.warn(`XmpAdjustmentRestore: sidecar read failed for ${id}`, err);
  }

  /**
   * A cold `/edit` deep-link mounts the editor without Browse ever running
   * `loadFolderTree()`, so `registeredFolders` (the slug → library-root map
   * that `absPathFor` resolves through) can be empty. Load it once, shared
   * across concurrent restores.
   */
  private _ensureRegisteredFolders(): Promise<void> {
    if (this.store.registeredFolders().length > 0) return Promise.resolve();
    this._foldersLoad ??= firstValueFrom(this.api.listFolders())
      .then((folders) => {
        // Don't stomp a richer list a concurrent loadFolderTree() landed.
        if (this.store.registeredFolders().length === 0) {
          this.store.registeredFolders.set(folders);
        }
      })
      .catch((err: unknown) => {
        this._foldersLoad = null; // allow a later restore to retry
        throw err;
      });
    return this._foldersLoad;
  }

  /** Mirror `openFolder()`'s sidecar-existence contract: a restored sidecar
   *  flips the asset's `edited` flag (the S2 "Edited" filter chip signal). */
  private _markEdited(id: AssetId): void {
    this.store.assets.update((list) =>
      list.map((a) => (a.id === id && !a.edited ? { ...a, edited: true } : a)),
    );
  }
}
