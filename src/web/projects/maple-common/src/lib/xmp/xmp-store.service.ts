// XmpStoreService — P6.
//
// Coordinates debounced, atomic sidecar writes for the Develop tab.
//
// - scheduleWrite()     debounces at 200ms then atomically writes the sidecar via
//                       FolderAccessService (FS Access writable-stream close is
//                       atomic on Chromium; fallback backend writes to IndexedDB).
// - rememberPassthrough stores the passthrough bucket from the last load so that
//                       subsequent writes can reproduce unknown content verbatim.
// - flushAll()          cancels all pending timers (call on beforeunload).

import { Injectable, inject } from '@angular/core';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { XmpCulling, PassthroughBucket } from './xmp.types';
import type { AssetId } from '../models/asset';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { SidecarSaveStateService } from './sidecar-save-state.service';

@Injectable({ providedIn: 'root' })
export class XmpStoreService {
  private folderAccess = inject(FolderAccessService);
  private serializer = inject(XmpSerializerService);
  private saveState = inject(SidecarSaveStateService);

  private readonly DEBOUNCE_MS = 200;

  /** Pending debounce handles keyed by AssetId. */
  private _pendingWrites = new Map<
    AssetId,
    {
      timeout: ReturnType<typeof setTimeout>;
      folder: MapleFolderHandle;
      rawFilename: string;
      model: AdjustmentModel;
      culling: XmpCulling;
      revision: number;
    }
  >();
  /** Latest serialized write chain for each asset. */
  private readonly _inFlightWrites = new Map<AssetId, Promise<void>>();

  /** Per-asset passthrough buckets loaded from the source sidecar. */
  private _passthroughs = new Map<AssetId, PassthroughBucket>();

  // ── Passthrough cache ───────────────────────────────────────────────────────

  /**
   * Store a passthrough bucket for an asset that was loaded externally
   * (e.g. when LibraryStateService calls the parser directly).
   */
  rememberPassthrough(assetId: AssetId, passthrough: PassthroughBucket): void {
    this._passthroughs.set(assetId, passthrough);
  }

  /**
   * Replace passthrough state for a freshly enumerated asset scope.
   *
   * Folder reopen uses this as one commit step after every sidecar has been
   * read. Deleting the complete scope first prevents a missing or removed
   * sidecar from inheriting unknown XML loaded during an earlier open.
   */
  replacePassthroughs(
    assetIds: Iterable<AssetId>,
    replacements: ReadonlyMap<AssetId, PassthroughBucket>,
  ): void {
    for (const assetId of assetIds) this._passthroughs.delete(assetId);
    for (const [assetId, passthrough] of replacements) {
      this._passthroughs.set(assetId, passthrough);
    }
  }

  /**
   * Look up the passthrough bucket previously stored for an asset (or undefined
   * if none was ever loaded). Used by callers that bypass `loadSidecar` /
   * `scheduleWrite` (e.g. the Self-Hosted API path in LibraryStateService).
   */
  passthroughFor(assetId: AssetId): PassthroughBucket | undefined {
    return this._passthroughs.get(assetId);
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  /**
   * Schedule a debounced sidecar write for `assetId`.
   * If a write is already pending for this asset, it is cancelled and replaced.
   * Does nothing when the folder has no write permission.
   */
  scheduleWrite(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
    model: AdjustmentModel,
    culling: XmpCulling,
  ): void {
    if (!folder.write) return;
    const revision = this.saveState.queued(assetId);

    const existing = this._pendingWrites.get(assetId);
    if (existing) clearTimeout(existing.timeout);

    const timeout = setTimeout(() => {
      this._pendingWrites.delete(assetId);
      void this._startWrite(
        assetId,
        folder,
        rawFilename,
        model,
        culling,
        revision,
        this._passthroughs.get(assetId),
      ).catch(() => undefined);
    }, this.DEBOUNCE_MS);

    this._pendingWrites.set(assetId, {
      timeout,
      folder,
      rawFilename,
      model,
      culling,
      revision,
    });
  }

  // ── Flush all (beforeunload) ────────────────────────────────────────────────

  /**
   * Cancel all pending timers.
   * Call from a beforeunload handler — modern Chromium will still finish any
   * in-flight writable-stream operations that have already been flushed to
   * the OS, but pending debounce timers that haven't fired yet are lost.
   * For the common case (user pauses, then closes tab) the 200ms debounce means
   * the write will already have fired before unload.
   */
  async flushAll(): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const [id, pending] of this._pendingWrites.entries()) {
      clearTimeout(pending.timeout);
      writes.push(
        this._startWrite(
          id,
          pending.folder,
          pending.rawFilename,
          pending.model,
          pending.culling,
          pending.revision,
          this._passthroughs.get(id),
        ),
      );
    }
    this._pendingWrites.clear();
    await Promise.all(new Set([...this._inFlightWrites.values(), ...writes]));
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _startWrite(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
    model: AdjustmentModel,
    culling: XmpCulling,
    revision: number,
    passthrough?: PassthroughBucket,
  ): Promise<void> {
    // File System Access writes are asynchronous. Serialize writes for the
    // same asset so an older, slower write can never overwrite a newer edit.
    const prior = this._inFlightWrites.get(assetId) ?? Promise.resolve();
    const write = prior
      .catch(() => undefined)
      .then(() =>
        this._flushWrite(assetId, folder, rawFilename, model, culling, revision, passthrough),
      )
      .finally(() => {
        if (this._inFlightWrites.get(assetId) === write) {
          this._inFlightWrites.delete(assetId);
        }
      });
    this._inFlightWrites.set(assetId, write);
    return write;
  }

  private async _flushWrite(
    assetId: AssetId,
    folder: MapleFolderHandle,
    rawFilename: string,
    model: AdjustmentModel,
    culling: XmpCulling,
    revision: number,
    passthrough?: PassthroughBucket,
  ): Promise<void> {
    this.saveState.saving(assetId, revision);
    const xml = this.serializer.serialize(model, passthrough, culling);
    const bytes = new TextEncoder().encode(xml);
    const sidecarName = this._sidecarFilename(rawFilename);
    try {
      // FolderAccessService.writeFile uses FS Access writable-stream on Chromium,
      // whose close() is atomic at the OS level.  The fallback backend writes to
      // IndexedDB which is also atomic.
      await this.folderAccess.writeFile(folder, sidecarName, bytes);
      this.saveState.saved(assetId, revision);
    } catch (e) {
      this.saveState.failed(assetId, revision, e);
      console.error(`XmpStoreService: write failed for ${rawFilename}:`, e);
      throw e;
    }
  }

  private _sidecarFilename(rawFilename: string): string {
    return rawFilename.replace(/\.[^.]+$/, '.xmp');
  }
}
