// SidecarStore — write-through sidecar cache for the Self-Hosted backend.
//
// Reads + caches XMP sidecars for the **Self-Hosted** backend's write path.
// Hosted (FS Access) still routes through `XmpStoreService` for
// schedule-debounced atomic writes — this store is the write-through / cache
// half, not a replacement for that writer.
//
// As of #801 the selection-time read path (the `httpResource` that fired
// `GET /api/xmp?path=…` whenever an asset was focused) is gone: it only ever
// drove the now-removed editor sidecar-status badge. Editor adjustment-restore
// reads XMP independently via `XmpAdjustmentRestoreService` (a lazy, once-per-
// focused-asset `GET /api/xmp` added by #2406 — between #801 and #2406 nothing
// read the sidecar back on reload/deep-link at all), and sidecar writes flow
// through `write()` below. The store keys on the source file's absolute
// filesystem path (see the design note on #193).
//
// Write semantics:
//
//   - Writes go to IDB optimistically (so a subsequent in-process read is
//     instant) and then to the network. On a failed network write the IDB row
//     is rolled back to the previous bytes — IDB and the server cannot diverge
//     silently.

import { Injectable, inject, signal } from '@angular/core';

import { LIBRARY_BACKEND } from '../api/library-backend.token';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { XmpCulling, PassthroughBucket } from './xmp.types';
import { XmpParserService } from './xmp-parser.service';
import { SIDECAR_CACHE, type SidecarCache } from './sidecar-idb-cache';
import { SERVER_WORKSPACE_PERSISTENCE } from '../workspace/workspace-persistence';
import { firstValueFrom } from 'rxjs';

/**
 * The store's view of a sidecar. Matches the shape returned by
 * `XmpParserService.parseAdjustmentModel` + `parseCulling`.
 */
export interface SidecarDoc {
  /** Absolute filesystem path of the source RAW this doc belongs to. */
  readonly path: string;
  readonly model: Partial<AdjustmentModel>;
  readonly culling: XmpCulling;
  readonly passthrough: PassthroughBucket;
  /** Raw XML — kept so writes can be sent through without re-serialising
   *  (callers do their own serialisation; the store accepts the resulting
   *  XML and stores it as-is). */
  readonly xml: string;
}

/**
 * Write-through sidecar cache for the Self-Hosted backend.
 *
 * Wire-up:
 *
 *     const store = inject(SidecarStore);
 *     await store.write(absPath, xml);
 *
 * Writes update the in-memory + IDB caches optimistically, then POST to the
 * server, rolling back on failure.
 */
@Injectable({ providedIn: 'root' })
export class SidecarStore {
  private readonly backend = inject(LIBRARY_BACKEND);
  private readonly parser = inject(XmpParserService);
  private readonly cache = inject<SidecarCache>(SIDECAR_CACHE);
  private readonly serverPersistence = inject(SERVER_WORKSPACE_PERSISTENCE);

  /** Optimistic cache: parsed docs keyed by path. Populated by `write()`. */
  private readonly _docs = signal<Map<string, SidecarDoc>>(new Map());

  // ── Mutators (optimistic write-through) ──────────────────────────────────

  /**
   * Write a sidecar through the store. Updates the in-memory cache and IDB
   * optimistically, then POSTs to the server. On a failed POST the optimistic
   * patch is rolled back to whatever was previously there (or removed if
   * nothing was).
   *
   * Returns the resolved server-side outcome. Throws if the POST fails *after*
   * the rollback so callers can surface the error.
   */
  async write(path: string, xml: string): Promise<void> {
    const previousMem = this._docs().get(path);
    // Capture IDB state BEFORE the optimistic write — `_ingest(..., true)`
    // fires `cache.put` and would otherwise overwrite the value we need to
    // roll back to. If IDB has a record but the in-memory cache doesn't
    // (callers can `write()` before ever observing the path), this is the
    // value we need to restore on failure.
    const previousIdb = previousMem ? null : await this.cache.get(path).catch(() => null);

    // 1. Optimistic in-memory + IDB write.
    await this._ingest(path, xml, /* persist */ true);
    try {
      // 2. Network. Only relevant on Self-Hosted; Hosted callers should keep
      //    using XmpStoreService.scheduleWrite (the FS Access debounced path).
      if (this.backend === 'self-hosted') {
        if (!this.serverPersistence)
          throw new Error('Self Hosted sidecar persistence is not configured');
        await firstValueFrom(this.serverPersistence.writeSidecar(path, xml));
      }
    } catch (err) {
      // 3. Rollback. We do this best-effort — if IDB write fails on rollback
      //    the in-memory state still reflects the previous value, which is
      //    what consumers actually observe.
      if (previousMem) {
        this._docs.update((m) => new Map(m).set(path, previousMem));
        await this.cache.put(path, previousMem.xml).catch((cacheErr) => {
          console.warn('SidecarStore: rollback IDB write failed', cacheErr);
        });
      } else if (previousIdb) {
        // We never had an in-memory doc, but IDB held one — restore it so we
        // don't silently destroy a cached prior version on a failed POST.
        this._docs.update((m) => {
          const next = new Map(m);
          next.delete(path);
          return next;
        });
        await this.cache.put(path, previousIdb.xml).catch((cacheErr) => {
          console.warn('SidecarStore: rollback IDB restore failed', cacheErr);
        });
      } else {
        // Nothing was there before — delete the optimistic row.
        this._docs.update((m) => {
          const next = new Map(m);
          next.delete(path);
          return next;
        });
        await this.cache.delete(path).catch(() => {
          /* best-effort */
        });
      }
      throw err;
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async _ingest(path: string, xml: string, persist: boolean): Promise<void> {
    try {
      const { model, passthrough } = this.parser.parseAdjustmentModel(xml);
      const culling = this.parser.parseCulling(xml);
      const doc: SidecarDoc = { path, model, culling, passthrough, xml };
      this._docs.update((m) => new Map(m).set(path, doc));
      if (persist) {
        await this.cache.put(path, xml).catch((err) => {
          console.warn('SidecarStore: IDB write failed', err);
        });
      }
    } catch (err) {
      console.warn('SidecarStore: parse failed', err);
    }
  }
}
