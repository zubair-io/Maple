// SidecarStore — slice 4 of #193 (path-keyed final form).
//
// Proof-of-shape implementation of the canonical `Store<T>` interface (see
// `../state/store.ts`). Reads + caches XMP sidecars for the **Self-Hosted**
// backend. Hosted (FS Access) still routes through `XmpStoreService` for
// schedule-debounced atomic writes — this store is the reader / cache half,
// not a replacement for that writer.
//
// As of slice 4 the store keys on the source file's absolute filesystem path
// (NOT the asset-id detour the earlier slices used). See the design note on
// issue #193 for why path is the right key. The endpoint shape is the
// path-keyed `/api/xmp?path=<urlencoded abs>` route added in slice 3 of #193.
//
// Pattern this store establishes for slices 5..N:
//
//   1. Inputs are reactive signals (here: `setActivePath(signal)`). The
//      `httpResource` factory closes over them so a change to the active path
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
//
//   5. `prefetch(path)` warms the cache for a path without making it the
//      active selection — orchestrators (e.g. folder open) can fan out a
//      bulk prefetch without disturbing the focused selection driven by
//      `setActivePath`.

import {
  Injectable,
  Injector,
  computed,
  effect,
  inject,
  signal,
  type EffectRef,
  type Signal,
} from '@angular/core';
import { httpResource } from '@angular/common/http';

import { API_BASE_URL } from '../api/api-base-url.token';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
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
  /** Absolute filesystem path of the source RAW this doc belongs to — useful
   *  when consumers see stale data during the brief window between an
   *  input-signal change and the new fetch resolving. */
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
 * Reactive sidecar reader + write-through IDB cache. Implements `Store<SidecarDoc>`.
 *
 * Wire-up:
 *
 *     const store = inject(SidecarStore);
 *     const activePath = signal<string | undefined>(undefined);
 *     store.setActivePath(activePath);
 *     // Then in template / computed:
 *     //   @switch (store.status()) { … }
 *     //   {{ store.data()?.culling.rating }}
 *
 * Only one active path at a time (single-entity by path). Multi-entity
 * coordination is left to a future `PhotoCollectionStore`.
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
   * The active source path. `setActivePath(...)` rewires this to an upstream
   * signal so the store re-fetches automatically when the consumer changes
   * which asset is selected.
   */
  private readonly _activePath = signal<string | undefined>(undefined);

  /** Optimistic cache: parsed docs keyed by path. Populated synchronously
   *  from IDB on first observation of a path, then refreshed by the network. */
  private readonly _docs = signal<Map<string, SidecarDoc>>(new Map());

  /** Paths whose IDB read is in-flight — prevents thrash when a path is
   *  visited twice in quick succession. */
  private readonly _idbReads = new Set<string>();

  // ── httpResource (network) ───────────────────────────────────────────────

  /**
   * Reactive HTTP read. The URL signal returns `undefined` when there's no
   * active path (or the backend isn't Self-Hosted), which puts the resource
   * in `idle` and produces no network request.
   */
  private readonly resource = httpResource.text(
    () => {
      const path = this._activePath();
      if (!path) return undefined;
      if (this.backend !== 'self-hosted') return undefined;
      // `this.base` already includes the `/api` prefix (see API_BASE_URL
      // token — defaults to `/api`). The slice-3 endpoint is `/api/xmp`, so
      // we append `/xmp` here, not `/api/xmp`.
      return `${this.base}/xmp?path=${encodeURIComponent(path)}`;
    },
    { defaultValue: '' },
  );

  // ── Side-effects ─────────────────────────────────────────────────────────

  constructor() {
    // On every successful network read, parse + write through to IDB.
    effect(() => {
      const status = this.resource.status();
      if (status !== 'resolved') return;
      const path = this._activePath();
      const xml = this.resource.value();
      if (!path || !xml) return;
      this._ingest(path, xml, /* persist */ true);
    });

    // When the active path changes, seed the cache from IDB so consumers see
    // a value immediately (the `loading` window collapses to zero for paths
    // we have seen before).
    effect(() => {
      const path = this._activePath();
      if (!path) return;
      if (this._docs().has(path)) return; // already in memory
      this._seedFromIdb(path);
    });
  }

  /** Best-effort, idempotent IDB → memory seed for a given path. Shared
   *  between the `setActivePath` effect and `prefetch(path)` so warming the
   *  cache for a non-focused path uses the same write-through path. */
  private _seedFromIdb(path: string): void {
    if (this._idbReads.has(path)) return;
    if (this._docs().has(path)) return;
    this._idbReads.add(path);
    void this.cache
      .get(path)
      .then((rec) => {
        if (rec) this._ingest(path, rec.xml, /* persist */ false);
      })
      .catch((err) => {
        console.warn('SidecarStore: IDB read failed', err);
      })
      .finally(() => this._idbReads.delete(path));
  }

  // ── Public surface: input wiring ─────────────────────────────────────────

  /** Held so repeat calls to `setActivePath(...)` tear down the previous
   *  upstream→local effect — otherwise each call would leak a live
   *  subscription on the prior signal. */
  private _activePathEffect?: EffectRef;

  /**
   * Wire the active path to an upstream signal. Subsequent reads of
   * `data()`, `status()`, etc. reflect whatever the upstream signal currently
   * holds.
   *
   * Passing `undefined` (the default) puts the store in `idle`. Calling this
   * a second time tears down the previous subscription before installing the
   * new one — no leak, and the old upstream signal stops driving the store.
   */
  setActivePath(pathSig: Signal<string | undefined>): void {
    // We intentionally don't use `linkedSignal` here — `effect` keeps the
    // upstream→local copy with minimal magic and stays testable without
    // ResourceRef internals. The store-level `Injector` is used so consumers
    // can call this outside an injection context (e.g. from a setter on a
    // view-model that already holds a signal).
    this._activePathEffect?.destroy();
    this._activePathEffect = effect(
      () => {
        this._activePath.set(pathSig());
      },
      { injector: this.injector },
    );
  }

  /** Imperative setter — convenience for tests and one-shot callers. */
  setActivePathValue(path: string | undefined): void {
    this._activePath.set(path);
  }

  // ── Store<SidecarDoc> implementation ─────────────────────────────────────

  /** Current sidecar doc for the active path, or undefined if not loaded. */
  readonly data: Signal<SidecarDoc | undefined> = computed(() => {
    const path = this._activePath();
    if (!path) return undefined;
    return this._docs().get(path);
  });

  /** First-fetch in flight (no value yet for this path). */
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

  /** Discriminated status — preferred read for templates.
   *
   *  Note: when an active path is set and the fetch has settled with no value
   *  (e.g. a 404 normalised to `null` error), we return `'not-found'` rather
   *  than `'idle'` — the latter means "we never asked", which is a different
   *  thing from "we asked, the server said nothing". */
  readonly status: Signal<StoreStatus> = computed(() => {
    if (!this._activePath()) return 'idle';
    if (this.error()) return 'error';
    if (this.loading()) return 'loading';
    if (this.refreshing()) return 'refreshing';
    if (this.data() !== undefined) return 'loaded';
    // Active path, not loading, no error, no data. If the resource has
    // actually completed (resolved or errored — the latter normalised to
    // `null` for 404), report `'not-found'` so callers can distinguish
    // "we asked, the server said nothing" from "we never asked".
    const rs = this.resource.status();
    if (rs === 'resolved' || rs === 'error') return 'not-found';
    return 'idle';
  });

  /**
   * Force a re-fetch of the active path. Mutators don't call this — use it
   * after pessimistic operations (delete, rescan) or external triggers (e.g.
   * indexer-surfaced file rename, where the cache key has gone stale).
   */
  invalidate(): void {
    this.resource.reload();
  }

  // ── Prefetch (slice 4: bulk hydration) ───────────────────────────────────

  /**
   * Warm the IDB → in-memory cache for `path` without making it the active
   * selection. Used by orchestrators (e.g. folder-open `_loadApiXmp`) to
   * fan-out pre-loading across a freshly-listed folder so the next
   * `setActivePath` for any of those paths resolves from memory without a
   * network round-trip.
   *
   * No-ops in Hosted mode (the store's HTTP path is gated to Self-Hosted; a
   * prefetch would just hit IDB, which is fine, but the bulk-load callers
   * only fire on Self-Hosted anyway).
   *
   * Behaviour:
   *   - If the path is already in the in-memory map, no-op.
   *   - Otherwise seed from IDB (fast, may resolve to nothing).
   *   - Then fetch from the network and write through to IDB. Errors are
   *     swallowed + logged — prefetch is best-effort and must never throw.
   *
   * Note that prefetch is fire-and-forget. Returns a Promise so callers can
   * `await` if they want to coordinate (e.g. tests), but the orchestrator's
   * happy path does not block on it.
   */
  async prefetch(path: string): Promise<void> {
    if (!path) return;
    if (this.backend !== 'self-hosted') return;
    if (this._docs().has(path)) return;

    // 1. IDB seed (instant first paint when we revisit this path).
    this._seedFromIdb(path);

    // 2. Network fetch + write-through. Skip if we already have it in memory
    //    by the time we get here (the IDB seed above may have completed).
    if (this._docs().has(path)) return;
    try {
      const xml = await firstValueFrom(this.api.getXmp(path));
      if (xml) this._ingest(path, xml, /* persist */ true);
    } catch (err) {
      // 404 is expected for un-edited assets; anything else we log and move on.
      const status = (err as unknown as { status?: number }).status;
      if (status !== 404) {
        console.warn('SidecarStore: prefetch failed for', path, err);
      }
    }
  }

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
    this._ingest(path, xml, /* persist */ true);
    try {
      // 2. Network. Only relevant on Self-Hosted; Hosted callers should keep
      //    using XmpStoreService.scheduleWrite (the FS Access debounced path).
      if (this.backend === 'self-hosted') {
        await firstValueFrom(this.api.putXmp(path, xml));
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

  private _ingest(path: string, xml: string, persist: boolean): void {
    try {
      const { model, passthrough } = this.parser.parseAdjustmentModel(xml);
      const culling = this.parser.parseCulling(xml);
      const doc: SidecarDoc = { path, model, culling, passthrough, xml };
      this._docs.update((m) => new Map(m).set(path, doc));
      if (persist) {
        void this.cache.put(path, xml).catch((err) => {
          console.warn('SidecarStore: IDB write failed', err);
        });
      }
    } catch (err) {
      console.warn('SidecarStore: parse failed', err);
    }
  }
}
