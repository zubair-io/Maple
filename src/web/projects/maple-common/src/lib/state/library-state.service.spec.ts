// LibraryStateService — Self-Hosted XMP passthrough round-trip (T4-followup).
//
// Verifies: when the Self-Hosted load path receives an XMP that contains an
// attribute outside Maple's known namespaces (e.g. <myvendor:custom>X</…>),
// editing an adjustment and triggering the debounced API write reproduces
// that vendor element verbatim in the body sent to BunApiBackendService.putXmp.

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject, of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { LibraryStateService } from './library-state.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import type { ApiAsset, ApiFolder, ApiAssetPage } from '../api/bun-api-backend.service';
import { LIBRARY_BACKEND } from '../api/library-backend.token';

const VENDOR_NODE = '<myvendor:custom xmlns:myvendor="http://example.com/v">X</myvendor:custom>';

const FIXTURE_XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmlns:myvendor="http://example.com/v"
    crs:Version="11.0"
    crs:ProcessVersion="11.0"
    crs:HasSettings="True"
    crs:Exposure2012="0.50">
  ${VENDOR_NODE}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

class ApiStub {
  putBodies: string[] = [];
  putXmp = vi.fn((_id: string, xml: string) => {
    this.putBodies.push(xml);
    return of(undefined as void);
  });
  getXmp = vi.fn((_id: string) => of(FIXTURE_XMP));

  // Folder / asset enumeration is not exercised here; we drive the load path
  // directly via openSelfHostedFolder() with a hand-built ApiFolder fixture.
  listFolders = vi.fn(() => of([] as ApiFolder[]));
  listAssets = vi.fn((_folderId: string) =>
    of({
      assets: [
        {
          id: 'remote-asset-1',
          filename: 'IMG_0001.dng',
          folderId: 'remote-folder-1',
          width: 6000,
          height: 4000,
          rating: 0,
          flag: 'unflagged',
          colorLabel: null,
        } satisfies ApiAsset,
      ],
      total: 1,
      page: 1,
      limit: 100,
    } satisfies ApiAssetPage),
  );
  getRawBytes = vi.fn(() => new Subject<ArrayBuffer>().asObservable());
  getThumb = vi.fn(() => new Subject<Blob>().asObservable());
  getAsset = vi.fn();
  registerFolder = vi.fn(() =>
    of({
      id: 'f1',
      path: '/photos',
      name: 'photos',
      assetCount: 0,
    } satisfies ApiFolder),
  );
}

describe('LibraryStateService — Self-Hosted passthrough round-trip (T4-followup)', () => {
  let api: ApiStub;
  let svc: LibraryStateService;

  beforeEach(() => {
    vi.useFakeTimers();
    api = new ApiStub();

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
        { provide: BunApiBackendService, useValue: api },
      ],
    });

    svc = TestBed.inject(LibraryStateService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves unknown-namespace nodes across an edit cycle', () => {
    // 1. Drive the Self-Hosted load path. listAssets() resolves synchronously
    //    via `of(...)`, so by the time subscribe() returns the asset is in
    //    the signal map and `_loadApiXmp` has already run (also synchronous
    //    because getXmp is `of(FIXTURE_XMP)`).
    svc.openSelfHostedFolder({
      id: 'remote-folder-1',
      path: '/srv/photos/folder-1',
      name: 'folder-1',
      assetCount: 1,
    });

    const asset = svc.assets()[0];
    expect(asset, 'asset registered after openSelfHostedFolder').toBeDefined();
    expect(api.getXmp).toHaveBeenCalledWith('remote-asset-1');

    // 2. Mutate an adjustment to trigger the debounced PUT.
    svc.updateAdjustment(asset.id, { exposure: 1.25 });

    // 3. Advance past the API_XMP_DEBOUNCE_MS (750ms).
    vi.advanceTimersByTime(800);

    // 4. The body should contain the vendor element verbatim.
    expect(api.putXmp).toHaveBeenCalledTimes(1);
    expect(api.putBodies).toHaveLength(1);
    const body = api.putBodies[0];
    expect(body).toContain('<myvendor:custom');
    expect(body).toContain('>X</myvendor:custom>');
  });

  describe('library picker visibility', () => {
    it('toggles via openLibraryPicker / closeLibraryPicker', () => {
      expect(svc.pickerVisible()).toBe(false);
      svc.openLibraryPicker();
      expect(svc.pickerVisible()).toBe(true);
      svc.closeLibraryPicker();
      expect(svc.pickerVisible()).toBe(false);
    });

    it('addLibraryFolder closes the picker on success', () => {
      const folder: ApiFolder = { id: 'f1', path: '/photos', name: 'photos', assetCount: 0 };
      api.registerFolder = vi.fn(() => of(folder));
      api.listFolders = vi.fn(() => of([folder]));

      svc.openLibraryPicker();
      expect(svc.pickerVisible()).toBe(true);
      svc.addLibraryFolder('/photos');
      // registerFolder and listFolders are `of(...)` — resolve synchronously.
      expect(svc.pickerVisible()).toBe(false);
    });
  });

  describe('addLibraryFolder (self-hosted)', () => {
    it('POSTs the path and refreshes the tree on success', () => {
      const folder: ApiFolder = { id: 'f1', path: '/photos', name: 'photos', assetCount: 0 };
      api.registerFolder = vi.fn(() => of(folder));
      api.listFolders = vi.fn(() => of([folder]));

      svc.addLibraryFolder('/photos');

      expect(api.registerFolder).toHaveBeenCalledWith('/photos');
      expect(api.listFolders).toHaveBeenCalled();
      expect(svc.backendEmpty()).toBe(false);
    });

    it('sets backendError on failure', () => {
      api.registerFolder = vi.fn(() =>
        throwError(
          () =>
            new HttpErrorResponse({
              error: { error: 'nope' },
              status: 400,
              statusText: 'Bad Request',
            }),
        ),
      );

      svc.addLibraryFolder('/bad');

      expect(svc.backendError()).toContain('nope');
    });
  });
});
