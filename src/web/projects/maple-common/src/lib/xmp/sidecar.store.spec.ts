// SidecarStore — unit tests for the canonical Store<T> proof.
//
// Covers (per #193 brief):
//   - `Store<T>` signal-transition shape: idle → loading → loaded → refreshing.
//   - `loading` vs `refreshing` semantics: refresh keeps the previous value
//     visible to consumers.
//   - IDB write-through round trip (via an in-memory `SidecarCache` fake).
//   - Optimistic write + rollback on a failed network PUT.
//   - 404 normalises to `null` error (no sidecar yet is not an error).

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';

import { SidecarStore } from './sidecar.store';
import {
  InMemorySidecarCache,
  SIDECAR_CACHE,
  type SidecarCache,
} from './sidecar-idb-cache';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { API_BASE_URL } from '../api/api-base-url.token';
import { BunApiBackendService } from '../api/bun-api-backend.service';

const ASSET_ID = 'asset-1';
const ASSET_ID_2 = 'asset-2';

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
  id: string;
  xml: string;
}

class ApiStub {
  putCalls: ApiPutCall[] = [];
  putResult: 'ok' | 'fail' = 'ok';
  putXmp = vi.fn((id: string, xml: string) => {
    this.putCalls.push({ id, xml });
    if (this.putResult === 'fail') {
      return throwError(() => new Error('PUT failed'));
    }
    return of(undefined as void);
  });
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

  it('starts in `idle` with no active id', () => {
    makeBed();
    store = TestBed.inject(SidecarStore);

    expect(store.status()).toBe('idle');
    expect(store.data()).toBeUndefined();
    expect(store.loading()).toBe(false);
    expect(store.refreshing()).toBe(false);
    expect(store.error()).toBeNull();
  });

  it('transitions idle → loading → loaded on first fetch', async () => {
    makeBed();
    store = TestBed.inject(SidecarStore);
    httpMock = TestBed.inject(HttpTestingController);

    const active = signal<string | undefined>(undefined);
    store.setActiveId(active);

    // Setting the active id flushes the linked effect via signal microtask.
    active.set(ASSET_ID);
    TestBed.tick(); // drain effects

    expect(store.status()).toBe('loading');
    expect(store.loading()).toBe(true);
    expect(store.refreshing()).toBe(false);
    expect(store.data()).toBeUndefined();

    const req = httpMock.expectOne(`/api/assets/${ASSET_ID}/xmp`);
    expect(req.request.method).toBe('GET');
    req.flush(SIDECAR_XML_BASIC);
    await flushAll();

    expect(store.status()).toBe('loaded');
    expect(store.loading()).toBe(false);
    const doc = store.data();
    expect(doc).toBeDefined();
    expect(doc!.id).toBe(ASSET_ID);
    expect(doc!.xml).toBe(SIDECAR_XML_BASIC);

    httpMock.verify();
  });

  it('invalidate() triggers a refresh that keeps the prior value visible', async () => {
    makeBed();
    store = TestBed.inject(SidecarStore);
    httpMock = TestBed.inject(HttpTestingController);

    const active = signal<string | undefined>(ASSET_ID);
    store.setActiveId(active);
    TestBed.tick();

    httpMock.expectOne(`/api/assets/${ASSET_ID}/xmp`).flush(SIDECAR_XML_BASIC);
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

    httpMock.expectOne(`/api/assets/${ASSET_ID}/xmp`).flush(SIDECAR_XML_UPDATED);
    await flushAll();

    expect(store.status()).toBe('loaded');
    expect(store.data()!.xml).toBe(SIDECAR_XML_UPDATED);
    httpMock.verify();
  });

  it('writes through to the cache on a successful network read', async () => {
    const cache = new InMemorySidecarCache();
    makeBed({ cache });
    store = TestBed.inject(SidecarStore);
    httpMock = TestBed.inject(HttpTestingController);

    store.setActiveIdValue(ASSET_ID);
    TestBed.tick();
    httpMock.expectOne(`/api/assets/${ASSET_ID}/xmp`).flush(SIDECAR_XML_BASIC);
    await flushAll();
    // Allow the write-through cache.put() microtask to settle.
    await Promise.resolve();
    await Promise.resolve();

    const rec = await cache.get(ASSET_ID);
    expect(rec).not.toBeNull();
    expect(rec!.xml).toBe(SIDECAR_XML_BASIC);
  });

  it('seeds data from the cache before the network resolves', async () => {
    const cache = new InMemorySidecarCache();
    await cache.put(ASSET_ID_2, SIDECAR_XML_BASIC);
    makeBed({ cache });
    store = TestBed.inject(SidecarStore);
    httpMock = TestBed.inject(HttpTestingController);

    store.setActiveIdValue(ASSET_ID_2);
    TestBed.tick();
    // Allow the async IDB read effect to flush.
    await Promise.resolve();
    await Promise.resolve();
    TestBed.tick();

    // Cache hit populates data before the network response — refreshing,
    // not loading.
    expect(store.data()).toBeDefined();
    expect(store.data()!.xml).toBe(SIDECAR_XML_BASIC);

    httpMock.expectOne(`/api/assets/${ASSET_ID_2}/xmp`).flush(SIDECAR_XML_BASIC);
    await flushAll();
    httpMock.verify();
  });

  it('normalises 404 to a null error (no sidecar yet is not an error)', async () => {
    makeBed();
    store = TestBed.inject(SidecarStore);
    httpMock = TestBed.inject(HttpTestingController);

    store.setActiveIdValue(ASSET_ID);
    TestBed.tick();
    httpMock
      .expectOne(`/api/assets/${ASSET_ID}/xmp`)
      .flush('not found', { status: 404, statusText: 'Not Found' });
    await flushAll();

    expect(store.error()).toBeNull();
    expect(store.status()).not.toBe('error');
  });

  it('write(id, xml) is optimistic + writes through to IDB', async () => {
    const cache = new InMemorySidecarCache();
    const { api } = makeBed({ cache });
    store = TestBed.inject(SidecarStore);
    TestBed.inject(HttpTestingController);

    await store.write(ASSET_ID, SIDECAR_XML_UPDATED);

    expect(api.putCalls).toHaveLength(1);
    expect(api.putCalls[0]).toEqual({ id: ASSET_ID, xml: SIDECAR_XML_UPDATED });
    const rec = await cache.get(ASSET_ID);
    expect(rec!.xml).toBe(SIDECAR_XML_UPDATED);
  });

  it('write rolls back the IDB cache when the network PUT fails', async () => {
    const cache = new InMemorySidecarCache();
    await cache.put(ASSET_ID, SIDECAR_XML_BASIC);
    const { api } = makeBed({ cache });
    store = TestBed.inject(SidecarStore);
    TestBed.inject(HttpTestingController);

    // Seed the in-memory cache by visiting the id (cache pre-populated; no
    // network needed for this test — but the store needs to know about the
    // previous value to roll back).
    store.setActiveIdValue(ASSET_ID);
    TestBed.tick();
    await Promise.resolve();
    await Promise.resolve();
    TestBed.tick();
    expect(store.data()!.xml).toBe(SIDECAR_XML_BASIC);

    api.putResult = 'fail';
    await expect(store.write(ASSET_ID, SIDECAR_XML_UPDATED)).rejects.toThrow('PUT failed');

    // Rolled back to previous value, both in memory and in IDB.
    expect(store.data()!.xml).toBe(SIDECAR_XML_BASIC);
    const rec = await cache.get(ASSET_ID);
    expect(rec!.xml).toBe(SIDECAR_XML_BASIC);
  });

  it('does not fetch when the backend is not self-hosted', () => {
    makeBed({ backend: 'hosted' });
    store = TestBed.inject(SidecarStore);
    httpMock = TestBed.inject(HttpTestingController);

    store.setActiveIdValue(ASSET_ID);
    TestBed.tick();

    // No URL is produced → no requests sent.
    httpMock.expectNone(`/api/assets/${ASSET_ID}/xmp`);
    expect(store.status()).toBe('idle');
  });
});
