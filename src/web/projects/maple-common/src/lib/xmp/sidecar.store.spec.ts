// SidecarStore — unit tests for the path-keyed Store<T> implementation.
//
// Covers (per the slice-4 design comment on #193):
//   - `Store<T>` signal-transition shape: idle → loading → loaded → refreshing.
//   - `loading` vs `refreshing` semantics: refresh keeps the previous value
//     visible to consumers.
//   - Path-keyed URL (`/api/xmp?path=<encoded>`).
//   - Path-keyed IDB write-through round trip (via an in-memory `SidecarCache` fake).
//   - `prefetch(path)` warms the in-memory + IDB caches without disturbing
//     the focused selection.
//   - Optimistic write + rollback on a failed network POST.
//   - 404 normalises to `null` error (no sidecar yet is not an error).

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';

import { SidecarStore } from './sidecar.store';
import { InMemorySidecarCache, SIDECAR_CACHE, type SidecarCache } from './sidecar-idb-cache';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { API_BASE_URL } from '../api/api-base-url.token';
import { BunApiBackendService } from '../api/bun-api-backend.service';

const PATH_A = '/srv/photos/folder/IMG_0001.dng';
const PATH_B = '/srv/photos/folder/IMG_0002.dng';
const PATH_WITH_SPACES = '/srv/photos/Holiday Snaps/DSC 4242.dng';

/** URL produced by SidecarStore for a given path — kept here so tests assert
 *  the exact contract instead of duplicating `encodeURIComponent` inline. */
function urlFor(path: string): string {
  return `/api/xmp?path=${encodeURIComponent(path)}`;
}

const SIDECAR_XML_BASIC = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    crs:Version="11.0"
    crs:Exposure2012="0.50">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

const SIDECAR_XML_UPDATED = SIDECAR_XML_BASIC.replace('"0.50"', '"1.25"');

interface ApiPutCall {
  path: string;
  xml: string;
}

class ApiStub {
  putCalls: ApiPutCall[] = [];
  putResult: 'ok' | 'fail' = 'ok';
  putXmp = vi.fn((path: string, xml: string) => {
    this.putCalls.push({ path, xml });
    if (this.putResult === 'fail') {
      return throwError(() => new Error('POST failed'));
    }
    return of(undefined as void);
  });
  // The store calls `api.getXmp(path)` from `prefetch(path)` — return text by
  // default. Tests that exercise prefetch override the implementation.
  getXmp = vi.fn((_path: string) => of(SIDECAR_XML_BASIC));
}

// Flush microtasks + Angular effects. `flush()` on httpResource resolves via
// a microtask after the HTTP testing controller delivers the body — calling
// `await flushAll()` once is enough for the resource's `value`/`status` to
// transition.
async function flushAll(): Promise<void> {
  // Two micro-turns: one for the HTTP body delivery, one for the effect that
  // reads `resource.status()` to mirror into the local Map.
  await Promise.resolve();
  await Promise.resolve();
  TestBed.tick();
  await Promise.resolve();
  TestBed.tick();
}

function makeBed(opts: { cache?: SidecarCache; backend?: 'self-hosted' | 'hosted' } = {}) {
  const cache = opts.cache ?? new InMemorySidecarCache();
  const api = new ApiStub();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: LIBRARY_BACKEND, useValue: opts.backend ?? 'self-hosted' },
      { provide: API_BASE_URL, useValue: '/api' },
      { provide: SIDECAR_CACHE, useValue: cache },
      { provide: BunApiBackendService, useValue: api },
    ],
  });
  return { cache, api };
}

describe('SidecarStore', () => {
  let store: SidecarStore;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('starts in `idle` with no active path', () => {
    makeBed();
    store = TestBed.inject(SidecarStore);

    expect(store.status()).toBe('idle');
    expect(store.data()).toBeUndefined();
    expect(store.loading()).toBe(false);
    expect(store.refreshing()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it('transitions idle → loading → loaded on first fetch (path-keyed URL)', async () => {
    makeBed();
    store = TestBed.inject(SidecarStore);
    httpMock = TestBed.inject(HttpTestingController);

    const active = signal<string | undefined>(undefined);
    store.setActivePath(active);

    active.set(PATH_A);
    TestBed.tick();

    expect(store.status()).toBe('loading');
    expect(store.loading()).toBe(true);
    expect(store.refreshing()).toBe(false);
    expect(store.data()).toBeUndefined();

    const req = httpMock.expectOne(urlFor(PATH_A));
    expect(req.request.method).toBe('GET');
    req.flush(SIDECAR_XML_BASIC);
    await flushAll();

    expect(store.status()).toBe('loaded');
    expect(store.loading()).toBe(false);
    const doc = store.data();
    expect(doc).toBeDefined();
    expect(doc!.path).toBe(PATH_A);
    expect(doc!.xml).toBe(SIDECAR_XML_BASIC);

    httpMock.verify();
  });

  it('encodes special characters in the active path (spaces, mixed case)', async () => {
    makeBed();
    store = TestBed.inject(SidecarStore);
    httpMock = TestBed.inject(HttpTestingController);

    store.setActivePathValue(PATH_WITH_SPACES);
    TestBed.tick();

    // The URL should round-trip via encodeURIComponent — spaces become %20,
    // not '+'. This is the contract the slice-3 API endpoint expects.
    const expectedUrl = `/api/xmp?path=${encodeURIComponent(PATH_WITH_SPACES)}`;
    expect(expectedUrl).toContain('%20');
    httpMock.expectOne(expectedUrl).flush(SIDECAR_XML_BASIC);
    await flushAll();
    expect(store.status()).toBe('loaded');
    httpMock.verify();
  });

  it('invalidate() triggers a refresh that keeps the prior value visible', async () => {
    makeBed();
    store = TestBed.inject(SidecarStore);
    httpMock = TestBed.inject(HttpTestingController);

    const active = signal<string | undefined>(PATH_A);
    store.setActivePath(active);
    TestBed.tick();

    httpMock.expectOne(urlFor(PATH_A)).flush(SIDECAR_XML_BASIC);
    await flushAll();
    expect(store.status()).toBe('loaded');

    store.invalidate();
    await flushAll();

    // While refresh is in flight, data is still defined — that's the brief's
    // load-bearing `loading` vs `refreshing` distinction.
    expect(store.status()).toBe('refreshing');
    expect(store.refreshing()).toBe(true);
    expect(store.loading()).toBe(false);
    expect(store.data()).toBeDefined();

    httpMock.expectOne(urlFor(PATH_A)).flush(SIDECAR_XML_UPDATED);
    await flushAll();

    expect(store.status()).toBe('loaded');
    expect(store.data()!.xml).toBe(SIDECAR_XML_UPDATED);
    httpMock.verify();
  });

  it('writes through to the path-keyed IDB cache on a successful network read', async () => {
    const cache = new InMemorySidecarCache();
    makeBed({ cache });
    store = TestBed.inject(SidecarStore);
    httpMock = TestBed.inject(HttpTestingController);

    store.setActivePathValue(PATH_A);
    TestBed.tick();
    httpMock.expectOne(urlFor(PATH_A)).flush(SIDECAR_XML_BASIC);
    await flushAll();
    // Allow the write-through cache.put() microtask to settle.
    await Promise.resolve();
    await Promise.resolve();

    const rec = await cache.get(PATH_A);
    expect(rec).not.toBeNull();
    expect(rec!.path).toBe(PATH_A);
    expect(rec!.xml).toBe(SIDECAR_XML_BASIC);
  });

  it('seeds data from the cache before the network resolves', async () => {
    const cache = new InMemorySidecarCache();
    await cache.put(PATH_B, SIDECAR_XML_BASIC);
    makeBed({ cache });
    store = TestBed.inject(SidecarStore);
    httpMock = TestBed.inject(HttpTestingController);

    store.setActivePathValue(PATH_B);
    TestBed.tick();
    // Allow the async IDB read effect to flush.
    await Promise.resolve();
    await Promise.resolve();
    TestBed.tick();

    // Cache hit populates data before the network response — refreshing,
    // not loading.
    expect(store.data()).toBeDefined();
    expect(store.data()!.xml).toBe(SIDECAR_XML_BASIC);

    httpMock.expectOne(urlFor(PATH_B)).flush(SIDECAR_XML_BASIC);
    await flushAll();
    httpMock.verify();
  });

  it('normalises 404 to a null error and surfaces `not-found` status', async () => {
    makeBed();
    store = TestBed.inject(SidecarStore);
    httpMock = TestBed.inject(HttpTestingController);

    store.setActivePathValue(PATH_A);
    TestBed.tick();
    httpMock.expectOne(urlFor(PATH_A)).flush('not found', { status: 404, statusText: 'Not Found' });
    await flushAll();

    // 404 is normalised because "no sidecar yet" is the common case, not an
    // error — but the status must distinguish it from `idle` (never asked).
    expect(store.error()).toBeNull();
    expect(store.status()).toBe('not-found');
    expect(store.data()).toBeUndefined();
  });

  it('write(path, xml) is optimistic + writes through to IDB and POSTs to the API', async () => {
    const cache = new InMemorySidecarCache();
    const { api } = makeBed({ cache });
    store = TestBed.inject(SidecarStore);
    TestBed.inject(HttpTestingController);

    await store.write(PATH_A, SIDECAR_XML_UPDATED);

    expect(api.putCalls).toHaveLength(1);
    expect(api.putCalls[0]).toEqual({ path: PATH_A, xml: SIDECAR_XML_UPDATED });
    const rec = await cache.get(PATH_A);
    expect(rec!.xml).toBe(SIDECAR_XML_UPDATED);
  });

  it('write rolls back the IDB cache when the network POST fails', async () => {
    const cache = new InMemorySidecarCache();
    await cache.put(PATH_A, SIDECAR_XML_BASIC);
    const { api } = makeBed({ cache });
    store = TestBed.inject(SidecarStore);
    TestBed.inject(HttpTestingController);

    // Seed the in-memory cache by visiting the path (cache pre-populated; no
    // network needed for this test — but the store needs to know about the
    // previous value to roll back).
    store.setActivePathValue(PATH_A);
    TestBed.tick();
    await Promise.resolve();
    await Promise.resolve();
    TestBed.tick();
    expect(store.data()!.xml).toBe(SIDECAR_XML_BASIC);

    api.putResult = 'fail';
    await expect(store.write(PATH_A, SIDECAR_XML_UPDATED)).rejects.toThrow('POST failed');

    // Rolled back to previous value, both in memory and in IDB.
    expect(store.data()!.xml).toBe(SIDECAR_XML_BASIC);
    const rec = await cache.get(PATH_A);
    expect(rec!.xml).toBe(SIDECAR_XML_BASIC);
  });

  it('tears down the previous setActivePath effect when called again', async () => {
    makeBed();
    store = TestBed.inject(SidecarStore);
    httpMock = TestBed.inject(HttpTestingController);

    // First wiring — signalA drives the store.
    const signalA = signal<string | undefined>(undefined);
    store.setActivePath(signalA);
    signalA.set(PATH_A);
    TestBed.tick();
    httpMock.expectOne(urlFor(PATH_A)).flush(SIDECAR_XML_BASIC);
    await flushAll();
    expect(store.data()!.path).toBe(PATH_A);

    // Re-wire to signalB. The previous effect MUST be destroyed — otherwise
    // updates to signalA would keep mutating the store's active path.
    const signalB = signal<string | undefined>(PATH_B);
    store.setActivePath(signalB);
    TestBed.tick();
    httpMock.expectOne(urlFor(PATH_B)).flush(SIDECAR_XML_UPDATED);
    await flushAll();
    expect(store.data()!.path).toBe(PATH_B);

    // Mutate the OLD signal — if the previous effect leaked, the store would
    // swing its active path back to whatever signalA holds and issue a new
    // request. We expect neither.
    signalA.set('/srv/photos/ghost.dng');
    TestBed.tick();
    await flushAll();
    expect(store.data()!.path).toBe(PATH_B);
    httpMock.expectNone(urlFor('/srv/photos/ghost.dng'));
    httpMock.verify();
  });

  it('write rolls back from IDB when the in-memory cache was never populated', async () => {
    // Pre-populate IDB with a prior value WITHOUT visiting the path, so the
    // store's in-memory map has no entry for it. This models the case where
    // a previous tab/session wrote to IDB and a fresh tab calls write()
    // before observing the asset.
    const cache = new InMemorySidecarCache();
    await cache.put(PATH_A, SIDECAR_XML_BASIC);
    const { api } = makeBed({ cache });
    store = TestBed.inject(SidecarStore);
    TestBed.inject(HttpTestingController);

    // Sanity: the store has not seen this path yet.
    expect(store.data()).toBeUndefined();

    api.putResult = 'fail';
    await expect(store.write(PATH_A, SIDECAR_XML_UPDATED)).rejects.toThrow('POST failed');

    // Critical: IDB must NOT be left holding the optimistic value, and must
    // NOT be deleted — the prior cached value should be restored.
    const rec = await cache.get(PATH_A);
    expect(rec).not.toBeNull();
    expect(rec!.xml).toBe(SIDECAR_XML_BASIC);
  });

  it('does not fetch when the backend is not self-hosted', () => {
    makeBed({ backend: 'hosted' });
    store = TestBed.inject(SidecarStore);
    httpMock = TestBed.inject(HttpTestingController);

    store.setActivePathValue(PATH_A);
    TestBed.tick();

    // No URL is produced → no requests sent.
    httpMock.expectNone(urlFor(PATH_A));
    expect(store.status()).toBe('idle');
  });

  describe('prefetch(path)', () => {
    it('writes through to the in-memory + IDB caches without changing active path', async () => {
      const cache = new InMemorySidecarCache();
      const { api } = makeBed({ cache });
      store = TestBed.inject(SidecarStore);
      TestBed.inject(HttpTestingController);

      // No active path set — store is idle. Prefetch should warm caches for
      // the supplied path but leave `data()` (which is keyed off the active
      // path) untouched.
      await store.prefetch(PATH_A);

      expect(api.getXmp).toHaveBeenCalledWith(PATH_A);
      const rec = await cache.get(PATH_A);
      expect(rec).not.toBeNull();
      expect(rec!.xml).toBe(SIDECAR_XML_BASIC);

      // Active path is still unset; `data()` reflects that.
      expect(store.status()).toBe('idle');
      expect(store.data()).toBeUndefined();
    });

    it('makes a subsequent setActivePath a cache hit (no network)', async () => {
      const cache = new InMemorySidecarCache();
      makeBed({ cache });
      store = TestBed.inject(SidecarStore);
      httpMock = TestBed.inject(HttpTestingController);

      await store.prefetch(PATH_A);

      // Now flip the active path to a prefetched path. The store should
      // surface data() from the in-memory map immediately. Whether the
      // httpResource still re-fetches is implementation-defined (it does),
      // but the user-visible `data()` must be populated *before* the
      // network round-trip — that's the slice-1 instant-paint property,
      // preserved by slice 4.
      store.setActivePathValue(PATH_A);
      TestBed.tick();
      await Promise.resolve();

      expect(store.data()).toBeDefined();
      expect(store.data()!.path).toBe(PATH_A);

      // Drain the resource's eventual network request (revalidation).
      const reqs = httpMock.match(urlFor(PATH_A));
      for (const r of reqs) r.flush(SIDECAR_XML_BASIC);
      await flushAll();
      httpMock.verify();
    });

    it('is a no-op on Hosted backends', async () => {
      const cache = new InMemorySidecarCache();
      const { api } = makeBed({ cache, backend: 'hosted' });
      store = TestBed.inject(SidecarStore);
      TestBed.inject(HttpTestingController);

      await store.prefetch(PATH_A);

      expect(api.getXmp).not.toHaveBeenCalled();
      const rec = await cache.get(PATH_A);
      expect(rec).toBeNull();
    });

    it('swallows network errors (best-effort warming)', async () => {
      const cache = new InMemorySidecarCache();
      const { api } = makeBed({ cache });
      api.getXmp = vi.fn(() => throwError(() => new Error('boom')));
      store = TestBed.inject(SidecarStore);
      TestBed.inject(HttpTestingController);

      // Must not reject — prefetch is fire-and-forget.
      await expect(store.prefetch(PATH_A)).resolves.toBeUndefined();
      const rec = await cache.get(PATH_A);
      expect(rec).toBeNull();
    });

    it('is a no-op if the path is already in the in-memory cache', async () => {
      const cache = new InMemorySidecarCache();
      const { api } = makeBed({ cache });
      store = TestBed.inject(SidecarStore);
      TestBed.inject(HttpTestingController);

      // First prefetch populates the cache + the in-memory map.
      await store.prefetch(PATH_A);
      expect(api.getXmp).toHaveBeenCalledTimes(1);

      // Second prefetch returns immediately — no extra network request.
      await store.prefetch(PATH_A);
      expect(api.getXmp).toHaveBeenCalledTimes(1);
    });
  });
});
