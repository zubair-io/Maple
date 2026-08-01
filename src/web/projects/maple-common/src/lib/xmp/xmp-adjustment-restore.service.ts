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

import { SERVER_WORKSPACE_PERSISTENCE } from '../workspace/workspace-persistence';
import { SERVER_LIBRARY_IO } from '../workspace/server-library-io';
import type { AssetId } from '../models/asset';
import type { AdjustmentModel } from '../models/adjustment-model';
import { LibraryStore } from '../state/library-store.service';
import { LibrarySelection } from '../state/library-selection.service';
import { XmpParserService } from './xmp-parser.service';
import { XmpStoreService } from './xmp-store.service';
import type { PassthroughBucket, XmpCulling } from './xmp.types';

export interface HydratedSidecar {
  readonly model: Partial<AdjustmentModel>;
  readonly passthrough: PassthroughBucket;
  readonly culling: XmpCulling;
}

@Injectable({ providedIn: 'root' })
export class XmpAdjustmentRestoreService {
  private readonly store = inject(LibraryStore);
  private readonly selection = inject(LibrarySelection);
  private readonly serverPersistence = inject(SERVER_WORKSPACE_PERSISTENCE, { optional: true });
  private readonly serverLibrary = inject(SERVER_LIBRARY_IO, { optional: true });
  private readonly parser = inject(XmpParserService);
  private readonly xmpStore = inject(XmpStoreService);

  /** Asset ids already fetched (or in flight) this session. */
  private readonly _attempted = new Set<AssetId>();

  /** One shared read per asset for restore and read-before-write coordination. */
  private readonly _sidecars = new Map<AssetId, Promise<HydratedSidecar | null>>();

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
      const sidecar = await this.loadForWrite(id);
      if (sidecar !== null) this._applyParsedSidecar(id, sidecar);
    } catch (err) {
      this._attempted.delete(id);
      console.warn(`XmpAdjustmentRestore: sidecar read failed for ${id}`, err);
    }
  }

  /**
   * Return the persisted sidecar model used as the base for a full-document
   * write. Sharing this promise with the focus restore prevents a culling edit
   * from racing the GET and replacing develop settings with defaults.
   */
  loadForWrite(id: AssetId): Promise<HydratedSidecar | null> {
    if (!this._addressable(id)) return Promise.resolve(null);
    const existing = this._sidecars.get(id);
    if (existing) return existing;

    const load = this._loadSidecar(id).catch((err: unknown) => {
      this._sidecars.delete(id);
      throw err;
    });
    this._sidecars.set(id, load);
    return load;
  }

  /** Self-Hosted `slug:relPath` assets not yet attempted this session. */
  private _eligible(id: AssetId): boolean {
    return this._addressable(id) && !this._attempted.has(id);
  }

  private _addressable(id: AssetId): boolean {
    return this.store.backend === 'self-hosted' && id.includes(':') && !id.startsWith('fs:');
  }

  /** Parsed sidecar for `id`, or `null` when none exists. */
  private async _loadSidecar(id: AssetId): Promise<HydratedSidecar | null> {
    await this._ensureRegisteredFolders();
    const absPath = this.store.absPathFor(id);
    if (!absPath) return null;
    if (!this.serverPersistence) return null;
    try {
      const xml = await firstValueFrom(this.serverPersistence.readSidecar(absPath));
      if (xml === null) return null;
      const sidecar = {
        ...this.parser.parseAdjustmentModel(xml),
        culling: this.parser.parseCulling(xml),
      };
      this.xmpStore.rememberPassthrough(id, sidecar.passthrough);
      return sidecar;
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 404) return null;
      throw err;
    }
  }

  private _applyParsedSidecar(id: AssetId, sidecar: HydratedSidecar): void {
    this.store.restoreAdjustment(id, sidecar.model);
    this.store.mergePersistedCulling(id, sidecar.culling);
    // A 200 means a sidecar exists on disk — flip `edited` even when
    // `restoreAdjustment` refused to overwrite (the user edited while the
    // GET was in flight). The "Edited" filter chip tracks sidecar
    // EXISTENCE, and `openFolder()` sets the flag on every successful
    // sidecar read regardless of the model's content.
    this._markEdited(id);
  }

  /**
   * A cold `/edit` deep-link mounts the editor without Browse ever running
   * `loadFolderTree()`, so `registeredFolders` (the slug → library-root map
   * that `absPathFor` resolves through) can be empty. Load it once, shared
   * across concurrent restores.
   */
  private _ensureRegisteredFolders(): Promise<void> {
    if (this.store.registeredFolders().length > 0) return Promise.resolve();
    if (!this.serverLibrary) return Promise.resolve();
    this._foldersLoad ??= firstValueFrom(this.serverLibrary.listFolders())
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
