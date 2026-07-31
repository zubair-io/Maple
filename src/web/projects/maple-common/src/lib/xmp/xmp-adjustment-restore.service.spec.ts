// XmpAdjustmentRestoreService — restore persisted XMP adjustments when a
// Self-Hosted asset becomes focused (#2406).
//
// The reload/deep-link hydration paths (`hydrateSelfHostedFsAsset`,
// `_applyFolderListing`, `addImportedAsset`) build Asset records but never
// read the sidecar back, so a cold `/edit/<slug>/<path>` load rendered every
// adjustment at defaults regardless of what was persisted. These tests drive
// the public facade (hydrate + focus) and assert the store's adjustment model
// is populated from REAL XMP XML through the REAL parser — the sidecar layer
// is never mocked (only the HTTP transport is), per the repo convention
// "XMP is the contract; mocks let bugs through".

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, of, throwError, type Observable } from 'rxjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { LibraryStateService } from '../state/library-state.service';
import { LibraryStore } from '../state/library-store.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import type { ApiFolder } from '../api/bun-api-backend.service';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { API_BASE_URL } from '../api/api-base-url.token';
import { STORAGE_KEYS } from '../util/typed-storage';
import { provideLibrarySource } from '../addressing/library-source-provider';
import { SIDECAR_CACHE } from './sidecar-idb-cache';
import type { AssetId } from '../models/asset';

// The deep-linked asset: `/edit/photos/raws/test_0004.fff` resolves to the
// address `photos:raws/test_0004.fff` inside the registered library at
// `/photos` (slug `photos`) — mirroring the production audit's repro.
const ASSET_ID = 'photos:raws/test_0004.fff' as AssetId;
const SIDECAR_ABS_PATH = '/photos/raws/test_0004.fff';

const LIBRARY: ApiFolder = {
  id: 'lib1',
  path: '/photos',
  slug: 'photos',
  label: 'photos',
  last_scan: null,
  file_count: 1,
  created_at: '2026-01-01T00:00:00Z',
};

// Real XMP as written by ACR/Maple — parsed by the real XmpParserService.
const SIDECAR_XML = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    crs:Version="11.0"
    crs:Exposure2012="1.05"
    crs:Vibrance="26">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

const clearPrefKeys = (): void => {
  for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
};

class ApiStub {
  getXmpResult: Observable<string> = of(SIDECAR_XML);
  getXmp = vi.fn((_path: string) => this.getXmpResult);
  putXmp = vi.fn((_path: string, _xml: string) => of(undefined as void));
  listFolders = vi.fn(() => of([LIBRARY]));
  scanFolder = vi.fn(() => new Subject<never>().asObservable());
}

class NoopSidecarCache {
  get = vi.fn(async () => null);
  put = vi.fn(async () => undefined);
  delete = vi.fn(async () => undefined);
}

describe('XmpAdjustmentRestoreService (#2406)', () => {
  let api: ApiStub;
  let state: LibraryStateService;
  let store: LibraryStore;

  beforeEach(() => {
    clearPrefKeys();
    api = new ApiStub();

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideLibrarySource,
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
        { provide: BunApiBackendService, useValue: api },
        { provide: SIDECAR_CACHE, useValue: new NoopSidecarCache() },
      ],
    });

    state = TestBed.inject(LibraryStateService);
    store = TestBed.inject(LibraryStore);
  });

  afterEach(() => {
    clearPrefKeys();
    vi.useRealTimers();
  });

  /** Deep-link hydration + focus, as editor-shell-route's
   *  `hydrateSlugDeepLink` performs it on a cold `/edit` load. */
  const hydrateAndFocus = (): void => {
    const synth = state.hydrateSelfHostedFsAsset(ASSET_ID);
    expect(synth).not.toBeNull();
    state.selectAsset(ASSET_ID);
    TestBed.tick(); // flush the focus effect that kicks off the restore
  };

  const flushAsync = async (): Promise<void> => {
    // Let the listFolders + getXmp microtask chain settle (the restore path
    // is a few awaits deep), then flush any effects the restore scheduled.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    TestBed.tick();
  };

  it('populates the store adjustment model from an existing sidecar on deep-link hydration', async () => {
    hydrateAndFocus();
    await flushAsync();

    expect(api.getXmp).toHaveBeenCalledWith(SIDECAR_ABS_PATH);
    const model = store.adjustmentFor(ASSET_ID)();
    expect(model.exposure).toBeCloseTo(1.05);
    expect(model.vibrance).toBeCloseTo(26);
  });

  it('leaves defaults in place when no sidecar exists (404)', async () => {
    api.getXmpResult = throwError(
      () => new HttpErrorResponse({ status: 404, statusText: 'Not Found' }),
    );

    hydrateAndFocus();
    await flushAsync();

    expect(api.getXmp).toHaveBeenCalledWith(SIDECAR_ABS_PATH);
    const model = store.adjustmentFor(ASSET_ID)();
    expect(model.exposure).toBe(0);
    expect(model.vibrance).toBe(0);
    expect(store.isEdited(ASSET_ID)()).toBe(false);
  });

  it('does not clobber an in-session edit with a late-arriving restore response', async () => {
    const deferred = new Subject<string>();
    api.getXmpResult = deferred.asObservable();

    hydrateAndFocus();
    await flushAsync();

    // The user edits Exposure while the sidecar fetch is still in flight.
    state.updateAdjustment(ASSET_ID, { exposure: 2.5 });

    // The stale sidecar (exposure 1.05) arrives afterwards.
    deferred.next(SIDECAR_XML);
    deferred.complete();
    await flushAsync();

    const model = store.adjustmentFor(ASSET_ID)();
    expect(model.exposure).toBeCloseTo(2.5);
    // The 200 still proved a sidecar EXISTS, so the "Edited" filter-chip
    // flag flips even though the model kept the in-session edit —
    // mirroring openFolder(), which sets `edited` on every successful
    // sidecar read regardless of the model's content.
    const asset = store.assets().find((a) => a.id === ASSET_ID);
    expect(asset?.edited).toBe(true);
  });

  it('restores once per asset and fetches lazily (no refetch on refocus)', async () => {
    hydrateAndFocus();
    await flushAsync();
    expect(api.getXmp).toHaveBeenCalledTimes(1);

    // Refocusing the same asset must not refetch.
    state.selectAsset(ASSET_ID);
    TestBed.tick();
    await flushAsync();
    expect(api.getXmp).toHaveBeenCalledTimes(1);
  });

  it('debounced sidecar write after restore serializes the restored model (write path resolves the abs path)', async () => {
    vi.useFakeTimers();
    hydrateAndFocus();
    await flushAsync();

    // A later edit must persist restored values + the new edit to the
    // sibling .xmp of the deep-linked asset — this covers the post-M2
    // regression where `assetAbsPaths` was never populated and the
    // debounced POST /api/xmp silently no-oped.
    state.updateAdjustment(ASSET_ID, { contrast: 10 });
    await vi.advanceTimersByTimeAsync(800);

    expect(api.putXmp).toHaveBeenCalledTimes(1);
    const [path, xml] = api.putXmp.mock.calls[0]!;
    expect(path).toBe(SIDECAR_ABS_PATH);
    expect(xml).toContain('crs:Exposure2012');
    expect(xml).toContain('crs:Contrast2012');
  });
});
