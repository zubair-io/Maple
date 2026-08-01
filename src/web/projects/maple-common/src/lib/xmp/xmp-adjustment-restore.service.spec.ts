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
import { provideSelfHostedWorkspace } from '../workspace/self-hosted-workspace.providers';
import { SIDECAR_CACHE } from './sidecar-idb-cache';
import type { AssetId } from '../models/asset';
import { SidecarSaveStateService } from './sidecar-save-state.service';

// The deep-linked asset: `/edit/photos/raws/test_0004.fff` resolves to the
// address `photos:raws/test_0004.fff` inside the registered library at
// `/photos` (slug `photos`) — mirroring the production audit's repro.
const ASSET_ID = 'photos:raws/test_0004.fff' as AssetId;
const SIDECAR_ABS_PATH = '/photos/raws/test_0004.fff';
const NON_FOCUSED_ASSET_ID = 'photos:raws/test_0008.RAF' as AssetId;
const NON_FOCUSED_SIDECAR_PATH = '/photos/raws/test_0008.RAF';

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
    xmlns:maple="https://maple.app/ns/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:vendor="https://example.test/vendor/1.0/"
    xmp:Rating="3"
    xmp:Label="Blue"
    maple:Flag="pick"
    crs:Version="11.0"
    crs:Exposure2012="1.05"
    crs:Vibrance="26"
    vendor:OpaqueSetting="keep-me">
    <dc:subject><rdf:Bag><rdf:li>existing-keyword</rdf:li></rdf:Bag></dc:subject>
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
  let saveState: SidecarSaveStateService;

  beforeEach(() => {
    clearPrefKeys();
    api = new ApiStub();

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSelfHostedWorkspace(),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
        { provide: BunApiBackendService, useValue: api },
        { provide: SIDECAR_CACHE, useValue: new NoopSidecarCache() },
      ],
    });

    state = TestBed.inject(LibraryStateService);
    store = TestBed.inject(LibraryStore);
    saveState = TestBed.inject(SidecarSaveStateService);
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
    expect(store.assets().find((asset) => asset.id === ASSET_ID)).toMatchObject({
      rating: 3,
      flag: 'pick',
      colorLabel: 'blue',
      keywords: ['existing-keyword'],
    });
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

  it('waits for a delayed restore before writing and merges the authored edit over persisted XML', async () => {
    vi.useFakeTimers();
    const deferred = new Subject<string>();
    api.getXmpResult = deferred.asObservable();

    hydrateAndFocus();
    await flushAsync();
    state.updateAdjustment(ASSET_ID, { contrast: 14 });
    await vi.advanceTimersByTimeAsync(200);

    expect(api.putXmp).not.toHaveBeenCalled();

    deferred.next(SIDECAR_XML);
    deferred.complete();
    await flushAsync();

    expect(api.putXmp).toHaveBeenCalledTimes(1);
    const [, xml] = api.putXmp.mock.calls[0]!;
    expect(xml).toContain('crs:Exposure2012="1.05"');
    expect(xml).toContain('crs:Contrast2012="14"');
    expect(xml).toContain('vendor:OpaqueSetting="keep-me"');
    expect(store.adjustmentFor(ASSET_ID)().exposure).toBeCloseTo(1.05);
    expect(store.adjustmentFor(ASSET_ID)().contrast).toBeCloseTo(14);
    expect(xml).toContain('xmp:Rating="3"');
    expect(xml).toContain('papp:Flag="pick"');
    expect(xml).toContain('papp:ColorLabel="blue"');
    expect(xml).toContain('<rdf:li>existing-keyword</rdf:li>');
  });

  it('hydrates a non-focused asset before a culling-only write', async () => {
    vi.useFakeTimers();
    store.registeredFolders.set([LIBRARY]);
    const asset = state.hydrateSelfHostedFsAsset(NON_FOCUSED_ASSET_ID);
    expect(asset).not.toBeNull();

    state.setRating(NON_FOCUSED_ASSET_ID, 4);
    await vi.advanceTimersByTimeAsync(200);
    await flushAsync();

    expect(api.getXmp).toHaveBeenCalledWith(NON_FOCUSED_SIDECAR_PATH);
    expect(api.putXmp).toHaveBeenCalledTimes(1);
    const [path, xml] = api.putXmp.mock.calls[0]!;
    expect(path).toBe(NON_FOCUSED_SIDECAR_PATH);
    expect(xml).toContain('crs:Exposure2012="1.05"');
    expect(xml).toContain('vendor:OpaqueSetting="keep-me"');
    expect(xml).toContain('xmp:Rating="4"');
    expect(xml).toContain('papp:Flag="pick"');
    expect(xml).toContain('papp:ColorLabel="blue"');
    expect(xml).toContain('<rdf:li>existing-keyword</rdf:li>');
    expect(store.assets().find((asset) => asset.id === NON_FOCUSED_ASSET_ID)).toMatchObject({
      rating: 4,
      flag: 'pick',
      colorLabel: 'blue',
      keywords: ['existing-keyword'],
    });
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

  it('commits within 250ms, resolves the sibling path, and preserves unknown XML', async () => {
    vi.useFakeTimers();
    hydrateAndFocus();
    await flushAsync();

    // A later edit must persist restored values + the new edit to the
    // sibling .xmp of the deep-linked asset — this covers the post-M2
    // regression where `assetAbsPaths` was never populated and the
    // debounced POST /api/xmp silently no-oped.
    state.updateAdjustment(ASSET_ID, { contrast: 10 });
    await vi.advanceTimersByTimeAsync(199);
    expect(api.putXmp).not.toHaveBeenCalled();
    expect(saveState.hasUnsavedChanges()).toBe(true);

    await vi.advanceTimersByTimeAsync(1);

    expect(api.putXmp).toHaveBeenCalledTimes(1);
    const [path, xml] = api.putXmp.mock.calls[0]!;
    expect(path).toBe(SIDECAR_ABS_PATH);
    expect(xml).toContain('crs:Exposure2012');
    expect(xml).toContain('crs:Contrast2012');
    expect(xml).toContain('vendor:OpaqueSetting="keep-me"');
    expect(saveState.phase()).toBe('saved');
  });

  it('keeps the edit visibly unsaved when the sibling write fails', async () => {
    vi.useFakeTimers();
    api.putXmp.mockImplementation(() => throwError(() => new Error('disk is read-only')));
    hydrateAndFocus();
    await flushAsync();

    state.updateAdjustment(ASSET_ID, { contrast: 12 });
    await vi.advanceTimersByTimeAsync(200);

    expect(saveState.phase()).toBe('error');
    expect(saveState.error()).toContain('disk is read-only');
    expect(saveState.hasUnsavedChanges()).toBe(true);
  });

  it('clears a failed Self Hosted write after the next edit persists', async () => {
    vi.useFakeTimers();
    api.putXmp.mockImplementationOnce(() => throwError(() => new Error('disk is read-only')));
    hydrateAndFocus();
    await flushAsync();

    state.updateAdjustment(ASSET_ID, { contrast: 12 });
    await vi.advanceTimersByTimeAsync(200);
    expect(saveState.phase()).toBe('error');

    state.updateAdjustment(ASSET_ID, { contrast: 13 });
    await vi.advanceTimersByTimeAsync(200);

    expect(api.putXmp).toHaveBeenCalledTimes(2);
    expect(saveState.phase()).toBe('saved');
    expect(saveState.error()).toBeNull();
    expect(saveState.hasUnsavedChanges()).toBe(false);
  });
});
