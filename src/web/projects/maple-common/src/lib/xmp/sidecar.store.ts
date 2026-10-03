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
import type { AssetId } from '../models/asset';
import {
  SelfHostedWorkflowWriterService,
  type SelfHostedSemanticEdit,
} from './self-hosted-workflow-writer.service';
import { SidecarSaveStateService } from './sidecar-save-state.service';
import { PRIMARY_VARIANT_ID } from '../generated/workflow.generated';
import { workflowSidecarKey } from './workflow-sidecar-binding';

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
  private readonly workflow = inject(SelfHostedWorkflowWriterService);
  private readonly saveState = inject(SidecarSaveStateService);
  private readonly writes = new Map<string, Promise<void>>();
  private readonly semanticAssets = new Map<string, AssetId>();

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
  write(path: string, xml: string, variantId = PRIMARY_VARIANT_ID): Promise<void> {
    return this.serializeWrite(workflowSidecarKey(path, variantId), () =>
      this.writeOptimistically(path, xml, variantId),
    );
  }

  private async writeOptimistically(path: string, xml: string, variantId: string): Promise<void> {
    const key = workflowSidecarKey(path, variantId);
    const previousMem = this._docs().get(key);
    // Capture IDB state BEFORE the optimistic write — `_ingest(..., true)`
    // fires `cache.put` and would otherwise overwrite the value we need to
    // roll back to. If IDB has a record but the in-memory cache doesn't
    // (callers can `write()` before ever observing the path), this is the
    // value we need to restore on failure.
    const previousIdb = previousMem ? null : await this.cache.get(key).catch(() => null);

    // 1. Optimistic in-memory + IDB write.
    await this._ingest(path, xml, /* persist */ true, variantId);
    try {
      // 2. Network. Only relevant on Self-Hosted; Hosted callers should keep
      //    using XmpStoreService.scheduleWrite (the FS Access debounced path).
      if (this.backend === 'self-hosted') {
        if (!this.serverPersistence)
          throw new Error('Self Hosted sidecar persistence is not configured');
        if (this.workflow.hasPending(path, variantId))
          await firstValueFrom(this.workflow.flush(path, variantId));
        const published = await firstValueFrom(
          this.serverPersistence.writeSidecar(path, xml, variantId),
        );
        await this._ingest(path, published, /* persist */ true, variantId);
      }
    } catch (err) {
      // 3. Rollback. We do this best-effort — if IDB write fails on rollback
      //    the in-memory state still reflects the previous value, which is
      //    what consumers actually observe.
      if (previousMem) {
        this._docs.update((m) => new Map(m).set(key, previousMem));
        await this.cache.put(key, previousMem.xml).catch((cacheErr) => {
          console.warn('SidecarStore: rollback IDB write failed', cacheErr);
        });
      } else if (previousIdb) {
        // We never had an in-memory doc, but IDB held one — restore it so we
        // don't silently destroy a cached prior version on a failed POST.
        this._docs.update((m) => {
          const next = new Map(m);
          next.delete(key);
          return next;
        });
        await this.cache.put(key, previousIdb.xml).catch((cacheErr) => {
          console.warn('SidecarStore: rollback IDB restore failed', cacheErr);
        });
      } else {
        // Nothing was there before — delete the optimistic row.
        this._docs.update((m) => {
          const next = new Map(m);
          next.delete(key);
          return next;
        });
        await this.cache.delete(key).catch(() => {
          /* best-effort */
        });
      }
      throw err;
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  commitSemantic(
    id: AssetId,
    path: string,
    edit: SelfHostedSemanticEdit,
    variantId = PRIMARY_VARIANT_ID,
  ): Promise<void> {
    this.workflow.capture(path, edit, variantId);
    this.semanticAssets.set(workflowSidecarKey(path, variantId), id);
    return this.retrySemantic(path, variantId);
  }

  hasPendingSemantic(path: string, variantId = PRIMARY_VARIANT_ID): boolean {
    return this.workflow.hasPending(path, variantId);
  }

  /** Snapshot/restore publication shares the ordinary and semantic write barrier. */
  async publishWorkflow(
    id: AssetId,
    path: string,
    publish: () => Promise<string>,
    variantId = PRIMARY_VARIANT_ID,
  ): Promise<string> {
    const revision = this.saveState.queued(id);
    return this.serializeWrite(workflowSidecarKey(path, variantId), async () => {
      this.saveState.saving(id, revision);
      try {
        if (this.workflow.hasPending(path, variantId))
          await firstValueFrom(this.workflow.flush(path, variantId));
        const output = await publish();
        await this._ingest(path, output, true, variantId);
        this.saveState.saved(id, revision);
        return output;
      } catch (error) {
        this.saveState.failed(id, revision, error);
        throw error;
      }
    });
  }

  retrySemantic(path: string, variantId = PRIMARY_VARIANT_ID): Promise<void> {
    const key = workflowSidecarKey(path, variantId);
    const id = this.semanticAssets.get(key);
    if (!id) return Promise.reject(Error('No captured semantic action for this source.'));
    const revision = this.saveState.queued(id);
    return this.serializeWrite(key, async () => {
      this.saveState.saving(id, revision);
      try {
        const published = await firstValueFrom(this.workflow.flush(path, variantId));
        if (published === null) throw Error('The committed sidecar is missing.');
        await this._ingest(path, published, /* persist */ true, variantId);
        this.saveState.saved(id, revision);
        if (!this.workflow.hasPending(path, variantId)) this.semanticAssets.delete(key);
      } catch (error) {
        this.saveState.failed(id, revision, error);
        throw error;
      }
    });
  }

  async flushSemantic(): Promise<void> {
    await Promise.all(
      this.workflow
        .pendingSources()
        .map(({ path, variantId }) => this.retrySemantic(path, variantId)),
    );
    await Promise.all(this.writes.values());
  }

  private serializeWrite<T>(path: string, write: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(path) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(write);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.writes.set(path, settled);
    return next.finally(() => {
      if (this.writes.get(path) === settled) this.writes.delete(path);
    });
  }

  private async _ingest(
    path: string,
    xml: string,
    persist: boolean,
    variantId = PRIMARY_VARIANT_ID,
  ): Promise<void> {
    try {
      const { model, passthrough } = this.parser.parseAdjustmentModel(xml);
      const culling = this.parser.parseCulling(xml);
      const doc: SidecarDoc = { path, model, culling, passthrough, xml };
      const key = workflowSidecarKey(path, variantId);
      this._docs.update((m) => new Map(m).set(key, doc));
      if (persist) {
        await this.cache.put(key, xml).catch((err) => {
          console.warn('SidecarStore: IDB write failed', err);
        });
      }
    } catch (err) {
      console.warn('SidecarStore: parse failed', err);
    }
  }
}
