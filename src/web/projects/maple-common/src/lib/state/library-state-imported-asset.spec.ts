// LibraryStateService — in-memory RAW import path (Maple Hosted).
//
// Guards the contract that the landing-page "Open a photo" flow relies on:
//   (1) `addImportedAsset(bytes, filename)` returns a fresh UUID and stores the
//       asset in the `f-imported` folder.
//   (2) `bytesForAsset(id)` round-trips the exact byte payload back out, which
//       is what the raw-pipeline worker will feed into WASM `render_bytes`.
//   (3) `isSupportedRaw` is case-insensitive and covers the extensions listed
//       in the file-input `accept` attribute — mismatches would silently drop
//       user-picked RAWs on the landing page.
//
// If any of these regress, the OOM-trap E2E in src/web/e2e/raw-open.spec.ts
// would also fail, but much more slowly; unit coverage keeps the feedback
// loop tight.

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  LibraryStateService,
  SUPPORTED_RAW_EXTENSIONS,
  isSupportedRaw,
} from './library-state.service';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { STORAGE_KEYS } from '../util/typed-storage';
import { provideLibrarySource } from '../addressing/library-source-provider';

// This spec constructs the real BrowsePreferencesService (via
// LibraryStateService); its persistence effects write `cm.*` keys into the
// jsdom localStorage that vitest shares across spec files on a worker. Clear
// them around each test so nothing leaks into sibling spec files (#1142).
const clearPrefKeys = (): void => {
  for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
};
beforeEach(clearPrefKeys);
afterEach(clearPrefKeys);

describe('LibraryStateService.addImportedAsset', () => {
  let svc: LibraryStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideLibrarySource,
        { provide: LIBRARY_BACKEND, useValue: 'hosted' },
      ],
    });
    svc = TestBed.inject(LibraryStateService);
  });

  it('stores imported RAW bytes and exposes them via bytesForAsset', async () => {
    const bytes = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0xde, 0xad, 0xbe, 0xef]); // TIFF magic + junk
    const id = svc.addImportedAsset(bytes, 'test.DNG');

    // UUID shape — addImportedAsset returns crypto.randomUUID().
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const assets = svc.assets();
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      id,
      filename: 'test.DNG',
      folderId: 'f-imported',
      rating: 0,
      flag: 'unflagged',
    });

    // Round-trip the exact bytes — workers read from the LRU cache.
    const out = await svc.bytesForAsset(id);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual(Array.from(bytes));
  });

  it('appends each imported asset to the f-imported folder without duplicates', () => {
    const idA = svc.addImportedAsset(new Uint8Array(4), 'a.dng');
    const idB = svc.addImportedAsset(new Uint8Array(4), 'b.dng');
    expect(idA).not.toEqual(idB);

    const assets = svc.assets();
    expect(assets.map((a) => a.filename).sort()).toEqual(['a.dng', 'b.dng']);
    expect(assets.every((a) => a.folderId === 'f-imported')).toBe(true);
  });
});

describe('isSupportedRaw', () => {
  it('accepts every extension listed in the landing-page accept attribute', () => {
    // Keep this list in sync with projects/maple-syrup/src/app/landing/landing.component.html
    // and with SUPPORTED_RAW_EXTENSIONS in library-state.service.ts.
    const accepted = [
      'cr3',
      'nef',
      'arw',
      'dng',
      'cr2',
      'raf',
      'orf',
      'rw2',
      'pef',
      'srw',
      'x3f',
      '3fr',
      'mef',
      'fff',
      'dcr',
      'mos',
      'iiq',
      'mrw',
      'raw',
    ];
    for (const ext of accepted) {
      expect(isSupportedRaw(`IMG_0001.${ext}`), ext).toBe(true);
      expect(isSupportedRaw(`IMG_0001.${ext.toUpperCase()}`), `uppercase ${ext}`).toBe(true);
    }
  });

  it('rejects unknown extensions and path-less filenames', () => {
    expect(isSupportedRaw('photo.jpg')).toBe(false);
    expect(isSupportedRaw('photo.png')).toBe(false);
    expect(isSupportedRaw('README')).toBe(false);
    expect(isSupportedRaw('')).toBe(false);
  });

  it('exposes the canonical extension set so adjacent code can reuse it', () => {
    expect(SUPPORTED_RAW_EXTENSIONS.has('dng')).toBe(true);
    expect(SUPPORTED_RAW_EXTENSIONS.has('jpg')).toBe(false);
  });
});
