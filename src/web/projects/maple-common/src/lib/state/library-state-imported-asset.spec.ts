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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  LibraryStateService,
  SUPPORTED_RAW_EXTENSIONS,
  isSupportedRaw,
} from './library-state.service';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { STORAGE_KEYS } from '../util/typed-storage';
import { provideHostedWorkspace } from '../workspace/hosted-workspace.providers';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { FolderEntry } from '../folder-access/folder-access.types';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { LibraryFetch } from './library-fetch.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';

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
        provideHostedWorkspace(),
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

  it('clears a stale writable folder when entering a single-file workspace', () => {
    svc.currentFolder.set({ name: 'previous', read: true, write: true });
    const id = svc.enterSingleFileWorkspace(new Uint8Array([2]), 'first.dng', 'first-id');

    expect(svc.currentFolder()).toBeNull();
    expect(svc.assets().filter((asset) => asset.folderId === 'f-imported')).toEqual([
      expect.objectContaining({ id, filename: 'first.dng' }),
    ]);
    expect(svc.selectedSourceId()).toBe('f-imported');
    expect(svc.focusedAssetId()).toBe(id);
  });

  it('replaces a prior single-file import instead of growing a filmstrip', () => {
    svc.enterSingleFileWorkspace(new Uint8Array([1]), 'first.dng', 'first-id');

    const secondId = svc.enterSingleFileWorkspace(new Uint8Array([3]), 'second.dng', 'second-id');
    expect(svc.assets().filter((asset) => asset.folderId === 'f-imported')).toEqual([
      expect.objectContaining({ id: secondId, filename: 'second.dng' }),
    ]);
    expect(svc.assetsInSelectedFolder()).toHaveLength(1);
  });

  it('releases the previous single-file RAW bytes when replacing it', async () => {
    svc.enterSingleFileWorkspace(new Uint8Array([1]), 'first.dng', 'first-id');
    svc.enterSingleFileWorkspace(new Uint8Array([3]), 'second.dng', 'second-id');

    await expect(svc.bytesForAsset('first-id')).rejects.toThrow('no handle');
    await expect(svc.bytesForAsset('second-id')).resolves.toEqual(new Uint8Array([3]));
  });

  it('fails closed when a new folder cannot be enumerated', async () => {
    svc.currentFolder.set({ name: 'previous', read: true, write: true });
    svc.singleFileMemoryOnly.set(true);
    const folderAccess = TestBed.inject(FolderAccessService);
    vi.spyOn(folderAccess, 'listEntries').mockRejectedValue(new Error('Permission revoked'));

    await expect(svc.openFolder({ name: 'unavailable', read: true, write: true })).rejects.toThrow(
      'Permission revoked',
    );

    expect(svc.currentFolder()).toBeNull();
    expect(svc.singleFileMemoryOnly()).toBe(false);
  });

  it('does not attach a new persistence target while its sidecars are still loading', async () => {
    const previous = { name: 'previous', read: true, write: true };
    const next = { name: 'next', read: true, write: true };
    svc.currentFolder.set(previous);
    const folderAccess = TestBed.inject(FolderAccessService);
    const entry: FolderEntry = {
      name: 'IMG_0001.DNG',
      kind: 'file',
      getFile: () => Promise.resolve(new File([new Uint8Array([1])], 'IMG_0001.DNG')),
      getSubFolder: () => Promise.reject(new Error('not a folder')),
    };
    vi.spyOn(folderAccess, 'listEntries').mockResolvedValue([entry]);
    let resolveSidecar!: (bytes: Uint8Array) => void;
    vi.spyOn(folderAccess, 'readFile').mockImplementation((_folder, path) => {
      if (path === '.maple/index.json') return Promise.reject(new Error('cache miss'));
      return new Promise<Uint8Array>((resolve) => (resolveSidecar = resolve));
    });

    const opening = svc.openFolder(next);
    await vi.waitFor(() => expect(resolveSidecar).toBeTypeOf('function'));
    expect(svc.currentFolder()).toBeNull();

    resolveSidecar(new TextEncoder().encode('<not-xmp/>'));
    await opening;
    expect(svc.currentFolder()).toEqual(next);
  });

  it('gives folder assets stable address ids that expose their preview-cache location', async () => {
    const folderAccess = TestBed.inject(FolderAccessService);
    const entry: FolderEntry = {
      name: 'IMG_0001.DNG',
      kind: 'file',
      getFile: () => Promise.resolve(new File([new Uint8Array([1])], 'IMG_0001.DNG')),
      getSubFolder: () => Promise.reject(new Error('not a folder')),
    };
    vi.spyOn(folderAccess, 'listEntries').mockResolvedValue([entry]);
    vi.spyOn(folderAccess, 'readFile').mockRejectedValue(new Error('cache miss'));

    await svc.openFolder({ name: 'Summer Photos', read: true, write: false });

    expect(svc.assets()).toEqual([
      expect.objectContaining({ id: 'summer-photos:IMG_0001.DNG', filename: 'IMG_0001.DNG' }),
    ]);
  });

  it('keeps distinct fallback folders in separate address namespaces', async () => {
    const folderAccess = TestBed.inject(FolderAccessService);
    const entry: FolderEntry = {
      name: 'IMG_0001.DNG',
      kind: 'file',
      getFile: () => Promise.resolve(new File([new Uint8Array([1])], 'IMG_0001.DNG')),
      getSubFolder: () => Promise.reject(new Error('not a folder')),
    };
    vi.spyOn(folderAccess, 'listEntries').mockResolvedValue([entry]);
    vi.spyOn(folderAccess, 'readFile').mockRejectedValue(new Error('cache miss'));

    await svc.openFolder({ name: 'Summer Photos', read: true, write: false });
    await svc.openFolder({ name: 'Summer Photos', read: true, write: false });
    await svc.openFolder({ name: 'summer---photos', read: true, write: false });

    expect(svc.assets().map((asset) => asset.id)).toEqual([
      'summer-photos:IMG_0001.DNG',
      'summer-photos-2:IMG_0001.DNG',
      'summer-photos-3:IMG_0001.DNG',
    ]);
    expect(svc.assets().map((asset) => asset.folderId)).toEqual([
      'f-summer-photos',
      'f-summer-photos-2',
      'f-summer-photos-3',
    ]);
  });

  it('writes the active fallback namespace assets to its .maple index', async () => {
    const folderAccess = TestBed.inject(FolderAccessService);
    const mapleCache = TestBed.inject(MapleCacheService);
    const entry: FolderEntry = {
      name: 'IMG_0001.DNG',
      kind: 'file',
      getFile: () => Promise.resolve(new File([new Uint8Array([1])], 'IMG_0001.DNG')),
      getSubFolder: () => Promise.reject(new Error('not a folder')),
    };
    vi.spyOn(folderAccess, 'listEntries').mockResolvedValue([entry]);
    vi.spyOn(folderAccess, 'readFile').mockRejectedValue(new Error('cache miss'));
    const writeIndex = vi.spyOn(mapleCache, 'writeIndex').mockResolvedValue();
    const folder = { name: 'Summer Photos', read: true, write: true };

    await svc.openFolder(folder);
    await (
      TestBed.inject(LibraryFetch) as unknown as { _writeIndex(): Promise<void> }
    )._writeIndex();

    expect(writeIndex).toHaveBeenCalledWith(
      folder,
      expect.objectContaining({
        assets: [expect.objectContaining({ filename: 'IMG_0001.DNG' })],
      }),
    );
  });

  it('replaces stale adjustments and passthroughs when a folder is reopened', async () => {
    const folderAccess = TestBed.inject(FolderAccessService);
    const xmpStore = TestBed.inject(XmpStoreService);
    const entry = (name: string): FolderEntry => ({
      name,
      kind: 'file',
      getFile: () => Promise.resolve(new File([new Uint8Array([1])], name)),
      getSubFolder: () => Promise.reject(new Error('not a folder')),
    });
    const sidecar = (exposure: number, marker: string): Uint8Array =>
      new TextEncoder().encode(`
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:vendor="https://example.test/vendor"
      crs:Exposure2012="${exposure}"
      vendor:Marker="${marker}" />
  </rdf:RDF>
</x:xmpmeta>`);
    let reopened = false;

    vi.spyOn(folderAccess, 'listEntries').mockImplementation(async () =>
      reopened ? [entry('A.DNG')] : [entry('A.DNG'), entry('B.DNG')],
    );
    vi.spyOn(folderAccess, 'readFile').mockImplementation(async (_folder, path) => {
      if (path === '.maple/index.json') throw new Error('cache miss');
      if (reopened || !path.endsWith('.xmp')) throw new Error('sidecar miss');
      return path === 'A.xmp' ? sidecar(1, 'A') : sidecar(2, 'B');
    });

    const folder = { name: 'Raws', read: true, write: true };
    await svc.openFolder(folder);
    const aId = 'raws:A.DNG';
    const bId = 'raws:B.DNG';
    expect(svc.adjustmentModels().get(aId)?.exposure).toBe(1);
    expect(svc.adjustmentModels().get(bId)?.exposure).toBe(2);
    expect(xmpStore.passthroughFor(aId)?.unknownAttributes).toContainEqual({
      name: 'vendor:Marker',
      value: 'A',
    });

    reopened = true;
    await svc.openFolder(folder);

    expect(svc.adjustmentModels().get(aId)?.exposure).toBe(0);
    expect(svc.adjustmentModels().has(bId)).toBe(false);
    expect(xmpStore.passthroughFor(aId)).toBeUndefined();
    expect(xmpStore.passthroughFor(bId)).toBeUndefined();
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
      'erf',
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
