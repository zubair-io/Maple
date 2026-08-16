// LibraryStateService — Self-Hosted library-picker + addLibraryFolder tests.
//
// Slice 4 of #193 removed the dead `applyApiAssets` → `_loadApiXmp` code
// path that this file's original "passthrough round-trip" test exercised.
// The XMP round-trip contract is now covered end-to-end by
// `sidecar.store.spec.ts` (the path-keyed cache + write-through layer) +
// the serializer's own unit tests. The remaining tests here verify the
// picker / addLibraryFolder slice of the facade that's still in use.

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject, of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { LibraryStateService } from './library-state.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import type { ApiFolder } from '../api/bun-api-backend.service';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { API_BASE_URL } from '../api/api-base-url.token';
import { STORAGE_KEYS } from '../util/typed-storage';
import { provideSelfHostedWorkspace } from '../workspace/self-hosted-workspace.providers';

// This spec constructs the real BrowsePreferencesService (via
// LibraryStateService); its persistence effects write `cm.*` keys into the
// jsdom localStorage that vitest shares across spec files on a worker. Clear
// them around each test so nothing leaks into sibling spec files (#1142).
const clearPrefKeys = (): void => {
  for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
};
beforeEach(clearPrefKeys);
afterEach(clearPrefKeys);

class ApiStub {
  putXmp = vi.fn((_path: string, _xml: string) => of(undefined as void));

  // Folder / asset enumeration is not exercised here; we drive the load path
  // directly via openSelfHostedFolder() with a hand-built ApiFolder fixture.
  listFolders = vi.fn(() => of([] as ApiFolder[]));
  getRawBytes = vi.fn(() => new Subject<ArrayBuffer>().asObservable());
  getThumb = vi.fn(() => new Subject<Blob>().asObservable());
  getAsset = vi.fn();
  registerFolder = vi.fn(() =>
    of({
      id: 'f1',
      path: '/photos',
      label: 'photos',
      last_scan: null,
      file_count: 0,
      created_at: '2026-01-01T00:00:00Z',
    } as ApiFolder),
  );
}

describe('LibraryStateService — Self-Hosted picker + addLibraryFolder', () => {
  let api: ApiStub;
  let svc: LibraryStateService;

  beforeEach(() => {
    vi.useFakeTimers();
    api = new ApiStub();

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSelfHostedWorkspace(),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
        { provide: BunApiBackendService, useValue: api },
      ],
    });

    svc = TestBed.inject(LibraryStateService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The slice-4 migration (#193) removed the dead `openSelfHostedFolder` →
  // `applyApiAssets` → `_loadApiXmp` code path, so the previous passthrough
  // round-trip test that exercised it via `api.listAssets` no longer reaches
  // the XMP read at all. The live Self-Hosted load path (`_applyFsListing`)
  // does not touch XMP at browse time; editor adjustment-restore reads XMP via
  // `library-fetch.service` → `XmpParserService.parseAdjustmentModel` when an
  // asset is opened (#801 removed the old selection-time `SidecarStore` read).
  // The round-trip passthrough contract is covered by `sidecar.store.spec.ts`
  // and the serializer's own tests. We keep this file for the library-picker
  // and addLibraryFolder assertions below.

  describe('library picker visibility', () => {
    it('toggles via openLibraryPicker / closeLibraryPicker', () => {
      expect(svc.pickerVisible()).toBe(false);
      svc.openLibraryPicker();
      expect(svc.pickerVisible()).toBe(true);
      svc.closeLibraryPicker();
      expect(svc.pickerVisible()).toBe(false);
    });

    it('addLibraryFolder closes the picker on success', () => {
      const folder: ApiFolder = {
        id: 'f1',
        path: '/photos',
        label: 'photos',
        last_scan: null,
        file_count: 0,
        created_at: '2026-01-01T00:00:00Z',
      };
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
      const folder: ApiFolder = {
        id: 'f1',
        path: '/photos',
        label: 'photos',
        last_scan: null,
        file_count: 0,
        created_at: '2026-01-01T00:00:00Z',
      };
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

  describe('loadFolderTree — disconnected sources (#2892)', () => {
    const folder = (id: string, slug: string, connected?: boolean): ApiFolder => ({
      id,
      slug,
      path: `/mnt/${slug}`,
      label: slug,
      last_scan: null,
      file_count: 5,
      created_at: '2026-01-01T00:00:00Z',
      ...(connected === undefined ? {} : { connected }),
    });

    it('keeps disconnected sources out of the sidebar but in registeredFolders', () => {
      api.listFolders = vi.fn(() => of([folder('f1', 'photos', true), folder('f2', 'nas', false)]));

      svc.loadFolderTree();

      const treeIds = svc.sidebarTree().map((e) => e.id);
      expect(treeIds).toContain('photos:');
      expect(treeIds).not.toContain('nas:');
      // The full list (path resolution, Settings → Sources) still has both.
      expect(svc.registeredFolders().map((f) => f.id)).toEqual(['f1', 'f2']);
      expect(svc.backendEmpty()).toBe(false);
    });

    it('treats a missing `connected` field (pre-upgrade server) as connected', () => {
      api.listFolders = vi.fn(() => of([folder('f1', 'photos')]));

      svc.loadFolderTree();

      expect(svc.sidebarTree().map((e) => e.id)).toContain('photos:');
    });

    it('shows a retryable banner (not the add-a-folder empty state) when every source is unreachable', () => {
      api.listFolders = vi.fn(() =>
        of([folder('f1', 'photos', false), folder('f2', 'nas', false)]),
      );

      svc.loadFolderTree();

      expect(svc.sidebarTree()).toEqual([]);
      expect(svc.backendEmpty()).toBe(false);
      expect(svc.backendError()).toContain('unreachable');
    });
  });
});
