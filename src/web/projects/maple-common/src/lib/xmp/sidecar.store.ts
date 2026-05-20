// SidecarStore — slice 2 of N (Refs #193).
//
// Proof-of-shape implementation of the canonical `Store<T>` interface (see
// `../state/store.ts`). Reads + caches XMP sidecars for the **Self-Hosted**
// backend. Hosted (FS Access) still routes through `XmpStoreService` for
// schedule-debounced atomic writes — this store is the reader / cache half,
// not a replacement for that writer.
//
// Pattern this store establishes for slices 3..N:
//
//   1. Inputs are reactive signals (here: `setActiveId(signal)`). The
//      `httpResource` factory closes over them so a change to the active id
//      cancels the in-flight request and starts a new one.
//
//   2. Reads are write-through to IndexedDB via `SidecarCache`. The first
//      cold read after a tab reload hits IDB instantly (no network) while a
//      background refresh validates against the server — that's the
//      `loading` vs `refreshing` distinction in the brief.
//
//   3. Writes go to IDB optimistically (so the next read is instant) and then
//      to the network. On a failed network write the IDB row is rolled back
//      to the previous bytes — IDB and the server cannot diverge silently.
//
//   4. Mutators (here: `write`) do NOT call `invalidate()`. The race guard
//      handles ordering — invalidate is for pessimistic mutations or
//      out-of-band external events.

import {
  Injectable,
  Injector,
  computed,
  effect,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import { httpResource } from '@angular/common/http';

import { API_BASE_URL } from '../api/api-base-url.token';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import type { AssetId } from '../models/asset';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { XmpCulling, PassthroughBucket } from './xmp.types';
import { XmpParserService } from './xmp-parser.service';
import { SIDECAR_CACHE, type SidecarCache } from './sidecar-idb-cache';
import type { Store, StoreStatus } from '../state/store';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { firstValueFrom } from 'rxjs';

/**
 * The store's view of a sidecar. Matches the shape returned by
 * `XmpParserService.parseAdjustmentModel` + `parseCulling` so consumers can
 * use the same destructuring whether they came in via the FS Access path or
 * the Self-Hosted path.
 */
export interface SidecarDoc {
  /** AssetId this doc belongs to — useful when consumers see stale data
   *  during the brief window between an id-input change and the new fetch
   *  resolving. */
  readonly id: AssetId;
  readonly model: Partial<AdjustmentModel>;
  readonly culling: XmpCulling;
  readonly passthrough: PassthroughBucket;
  /** Raw XML — kept so writes can be sent through without re-serialising
   *  (slice 1 only handles cache + read; writes serialised by callers). */
  readonly xml: string;
}

/**
 * Reactive sidecar reader + write-through IDB cache. Implements `Store<SidecarDoc>`.
 *
 * Wire-up:
 *
 *     const store = inject(SidecarStore);
 *     const activeId = signal<AssetId | undefined>(undefined);
 *     store.setActiveId(activeId);
 *     // Then in template / computed:
 *     //   @switch (store.status()) { … }
 *     //   {{ store.data()?.culling.rating }}
 *
 * Only one active id at a time (single-entity by `AssetId`, per the brief).
 * Multi-entity coordination is left to slice 6 (`PhotoCollectionStore`).
 */
@Injectable({ providedIn: 'root' })
export class SidecarStore implements Store<SidecarDoc> {
  private readonly base = inject(API_BASE_URL);
  private readonly backend = inject(LIBRARY_BACKEND);
  private readonly parser = inject(XmpParserService);
  private readonly cache = inject<SidecarCache>(SIDECAR_CACHE);
  private readonly api = inject(BunApiBackendService);
  private readonly injector = inject(Injector);

  // ── Input signal: drives the URL the resource fetches ─────────────────────

  /**
   * The active asset id. `setActiveId(...)` rewires this to an upstream
   * signal so the store re-fetches automatically when the consumer changes
   * which asset is selected.
   */
  private readonly _activeId = signal<AssetId | undefined>(undefined);

  /** Optimistic cache: parsed docs keyed by id. Populated synchronously from
   *  IDB on first observation of an id, then refreshed by the network. */
  private readonly _docs = signal<Map<AssetId, SidecarDoc>>(new Map());

  /** Ids whose IDB read is in-flight — prevents thrash when an id is
   *  visited twice in quick succession. */
  private readonly _idbReads = new Set<AssetId>();

  // ── httpResource (network) ───────────────────────────────────────────────

  /**
   * Reactive HTTP read. The URL signal returns `undefined` when there's no
   * active id (or the backend isn't Self-Hosted), which puts the resource in
   * `idle` and produces no network request.
   */
  private readonly resource = httpResource.text(
    () => {
      const id = this._activeId();
      if (!id) return undefined;
      if (this.backend !== 'self-hosted') return undefined;
      return `${this.base}/assets/${encodeURIComponent(id)}/xmp`;
    },
    { defaultValue: '' },
  );

  // ── Side-effects ─────────────────────────────────────────────────────────

  constructor() {
    // On every successful network read, parse + write through to IDB.
    effect(() => {
      const status = this.resource.status();
      if (status !== 'resolved') return;
      const id = this._activeId();
      const xml = this.resource.value();
      if (!id || !xml) return;
      this._ingest(id, xml, /* persist */ true);
    });

    // When the active id changes, seed the cache from IDB so consumers see
    // a value immediately (the `loading` window collapses to zero for ids
    // we have seen before).
    effect(() => {
      const id = this._activeId();
      if (!id) return;
      if (this._docs().has(id)) return; // already in memory
      if (this._idbReads.has(id)) return;
      this._idbReads.add(id);
      void this.cache
        .get(id)
        .then((rec) => {
          if (rec) this._ingest(id, rec.xml, /* persist */ false);
        })
        .catch((err) => {
          console.warn('SidecarStore: IDB read failed', err);
        })
        .finally(() => this._idbReads.delete(id));
    });
  }

  // ── Public surface: input wiring ─────────────────────────────────────────

  /**
   * Wire the active id to an upstream signal. Subsequent reads of `data()`,
   * `status()`, etc. reflect whatever the upstream signal currently holds.
   *
   * Passing `undefined` (the default) puts the store in `idle`.
   */
  setActiveId(idSig: Signal<AssetId | undefined>): void {
    // We intentionally don't use `linkedSignal` here — `effect` keeps the
    // upstream→local copy with minimal magic and stays testable without
    // ResourceRef internals. The store-level `Injector` is used so consumers
    // can call this outside an injection context (e.g. from a setter on a
    // view-model that already holds a signal).
    effect(
      () => {
        this._activeId.set(idSig());
      },
      { injector: this.injector },
    );
  }

  /** Imperative setter — convenience for tests and one-shot callers. */
  setActiveIdValue(id: AssetId | undefined): void {
    this._activeId.set(id);
  }

  // ── Store<SidecarDoc> implementation ─────────────────────────────────────

  /** Current sidecar doc for the active asset, or undefined if not loaded. */
  readonly data: Signal<SidecarDoc | undefined> = computed(() => {
    const id = this._activeId();
    if (!id) return undefined;
    return this._docs().get(id);
  });

  /** First-fetch in flight (no value yet for this id). */
  readonly loading: Signal<boolean> = computed(() => {
    return this.resource.isLoading() && this.data() === undefined;
  });

  /** Re-fetch in flight while a prior value is still visible. */
  readonly refreshing: Signal<boolean> = computed(() => {
    return this.resource.isLoading() && this.data() !== undefined;
  });

  /** Last error from the loader (network or parse). 404s are normalised to
   *  `null` because "no sidecar yet" is the common case, not an error. */
  readonly error: Signal<Error | null> = computed(() => {
    const err = this.resource.error();
    if (!err) return null;
    // HttpErrorResponse uses `status` on its body; sniff for 404 without
    // importing the type to keep this store framework-light.
    const status = (err as unknown as { status?: number }).status;
    if (status === 404) return null;
    return err;
  });

  /** Discriminated status — preferred read for templates. */
  readonly status: Signal<StoreStatus> = computed(() => {
    if (!this._activeId()) return 'idle';
    if (this.error()) return 'error';
    if (this.loading()) return 'loading';
    if (this.refreshing()) return 'refreshing';
    return this.data() !== undefined ? 'loaded' : 'idle';
  });

  /**
   * Force a re-fetch of the active id. Mutators don't call this — use it
   * after pessimistic operations (delete, rescan) or external triggers.
   */
  invalidate(): void {
    this.resource.reload();
  }

  // ── Mutators (optimistic write-through, slice 2) ─────────────────────────

  /**
   * Write a sidecar through the store. Updates the in-memory cache and IDB
   * optimistically, then PUTs to the server. On a failed PUT the optimistic
   * patch is rolled back to whatever was previously there (or removed if
   * nothing was).
   *
   * Returns the resolved server-side outcome. Throws if the PUT fails *after*
   * the rollback so callers can surface the error.
   */
  async write(id: AssetId, xml: string): Promise<void> {
    const previous = this._docs().get(id);
    // 1. Optimistic in-memory + IDB write.
    this._ingest(id, xml, /* persist */ true);
    try {
      // 2. Network. Only relevant on Self-Hosted; Hosted callers should keep
      //    using XmpStoreService.scheduleWrite (the FS Access debounced path).
      if (this.backend === 'self-hosted') {
        await firstValueFrom(this.api.putXmp(id, xml));
      }
    } catch (err) {
      // 3. Rollback. We do this best-effort — if IDB write fails on rollback
      //    the in-memory state still reflects the previous value, which is
      //    what consumers actually observe.
      if (previous) {
        this._docs.update((m) => new Map(m).set(id, previous));
        await this.cache.put(id, previous.xml).catch((cacheErr) => {
          console.warn('SidecarStore: rollback IDB write failed', cacheErr);
        });
      } else {
        this._docs.update((m) => {
          const next = new Map(m);
          next.delete(id);
          return next;
        });
        await this.cache.delete(id).catch(() => {
          /* best-effort */
        });
      }
      throw err;
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private _ingest(id: AssetId, xml: string, persist: boolean): void {
    try {
      const { model, passthrough } = this.parser.parseAdjustmentModel(xml);
      const culling = this.parser.parseCulling(xml);
      const doc: SidecarDoc = { id, model, culling, passthrough, xml };
      this._docs.update((m) => new Map(m).set(id, doc));
      if (persist) {
        void this.cache.put(id, xml).catch((err) => {
          console.warn('SidecarStore: IDB write failed', err);
        });
      }
    } catch (err) {
      console.warn('SidecarStore: parse failed', err);
    }
  }
}
