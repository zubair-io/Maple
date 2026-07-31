// SidecarStore — unit tests for the write-through sidecar cache.
//
// As of #801 the selection-time read path (`httpResource` →
// `GET /api/xmp?path=…`) is gone — it only drove the removed editor
// sidecar-status badge. What remains is the optimistic write-through:
//   - `write(path, xml)` POSTs to the API and writes through to IDB.
//   - On a failed POST the optimistic patch rolls back to the previous bytes
//     (from the in-memory doc, or from IDB if memory never held one, or a
//     delete if nothing was there before).

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { SidecarStore } from './sidecar.store';
import { InMemorySidecarCache, SIDECAR_CACHE, type SidecarCache } from './sidecar-idb-cache';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { API_BASE_URL } from '../api/api-base-url.token';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { SERVER_WORKSPACE_PERSISTENCE } from '../workspace/workspace-persistence';

const PATH_A = '/srv/photos/folder/IMG_0001.dng';

const SIDECAR_XML_BASIC = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core">
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
      {
        provide: SERVER_WORKSPACE_PERSISTENCE,
        useValue: {
          writeSidecar: (path: string, xml: string) => api.putXmp(path, xml),
        },
      },
    ],
  });
  return { cache, api };
}

describe('SidecarStore', () => {
  let store: SidecarStore;

  beforeEach(() => {
    TestBed.resetTestingModule();
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

  it('write rolls back to the previous in-memory doc when the network POST fails', async () => {
    const cache = new InMemorySidecarCache();
    const { api } = makeBed({ cache });
    store = TestBed.inject(SidecarStore);
    TestBed.inject(HttpTestingController);

    // A prior successful write populates the in-memory map + IDB.
    await store.write(PATH_A, SIDECAR_XML_BASIC);
    expect((await cache.get(PATH_A))!.xml).toBe(SIDECAR_XML_BASIC);

    // The next write fails on the network — must roll back to the prior bytes
    // in both memory and IDB.
    api.putResult = 'fail';
    await expect(store.write(PATH_A, SIDECAR_XML_UPDATED)).rejects.toThrow('POST failed');

    const rec = await cache.get(PATH_A);
    expect(rec!.xml).toBe(SIDECAR_XML_BASIC);
  });

  it('write rolls back from IDB when the in-memory cache was never populated', async () => {
    // Pre-populate IDB with a prior value WITHOUT a prior write, so the
    // store's in-memory map has no entry for it. This models the case where
    // a previous tab/session wrote to IDB and a fresh tab calls write()
    // before observing the asset.
    const cache = new InMemorySidecarCache();
    await cache.put(PATH_A, SIDECAR_XML_BASIC);
    const { api } = makeBed({ cache });
    store = TestBed.inject(SidecarStore);
    TestBed.inject(HttpTestingController);

    api.putResult = 'fail';
    await expect(store.write(PATH_A, SIDECAR_XML_UPDATED)).rejects.toThrow('POST failed');

    // Critical: IDB must NOT be left holding the optimistic value, and must
    // NOT be deleted — the prior cached value should be restored.
    const rec = await cache.get(PATH_A);
    expect(rec).not.toBeNull();
    expect(rec!.xml).toBe(SIDECAR_XML_BASIC);
  });

  it('write deletes the optimistic IDB row when nothing was there before and the POST fails', async () => {
    const cache = new InMemorySidecarCache();
    const { api } = makeBed({ cache });
    store = TestBed.inject(SidecarStore);
    TestBed.inject(HttpTestingController);

    api.putResult = 'fail';
    await expect(store.write(PATH_A, SIDECAR_XML_UPDATED)).rejects.toThrow('POST failed');

    // No prior value anywhere → the optimistic row is removed entirely.
    const rec = await cache.get(PATH_A);
    expect(rec).toBeNull();
  });

  it('does not POST to the network on Hosted backends', async () => {
    const cache = new InMemorySidecarCache();
    const { api } = makeBed({ cache, backend: 'hosted' });
    store = TestBed.inject(SidecarStore);
    TestBed.inject(HttpTestingController);

    await store.write(PATH_A, SIDECAR_XML_UPDATED);

    // Hosted callers keep using XmpStoreService; this store only writes through
    // to IDB on Hosted.
    expect(api.putXmp).not.toHaveBeenCalled();
    const rec = await cache.get(PATH_A);
    expect(rec!.xml).toBe(SIDECAR_XML_UPDATED);
  });
});
