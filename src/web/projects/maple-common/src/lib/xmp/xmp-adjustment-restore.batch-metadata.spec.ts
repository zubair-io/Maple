import { TestBed } from '@angular/core/testing';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { from, of, type Observable } from 'rxjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { LibraryStateService } from '../state/library-state.service';
import { LibraryStore } from '../state/library-store.service';
import { LIBRARY_SOURCE, type FolderListing } from '../addressing/library-source';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import type { ApiFolder } from '../api/bun-api-backend.service';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { API_BASE_URL } from '../api/api-base-url.token';
import { STORAGE_KEYS } from '../util/typed-storage';
import { provideSelfHostedWorkspace } from '../workspace/self-hosted-workspace.providers';
import { SIDECAR_CACHE } from './sidecar-idb-cache';
import type { AssetId } from '../models/asset';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { BatchApplyMetadata } from '../batch-metadata/batch-metadata.types';
import { XmpAdjustmentRestoreService } from './xmp-adjustment-restore.service';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { XmpStoreService } from './xmp-store.service';
import { FolderAccessService } from '../folder-access/folder-access.service';
import {
  fsAccessListEntries,
  fsAccessReadFile,
  fsAccessWriteFile,
} from '../folder-access/fs-access-backend';

const ASSET_ID = 'photos:raws/test_0004.fff' as AssetId;
const NON_FOCUSED_ASSET_ID = 'photos:raws/test_0008.RAF' as AssetId;

const LIBRARY: ApiFolder = {
  id: 'lib1',
  path: '/photos',
  slug: 'photos',
  label: 'photos',
  last_scan: null,
  file_count: 1,
  created_at: '2026-01-01T00:00:00Z',
};

const SIDECAR_XML = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmlns:maple="https://maple.app/ns/1.0/"
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:vendor="https://example.test/vendor/1.0/"
    xmp:Rating="3"
    xmp:Label="Blue"
    maple:Flag="pick"
    crs:Version="11.0"
    crs:Exposure2012="1.05"
    crs:Vibrance="26"
    photoshop:City="Montréal"
    vendor:OpaqueSetting="keep-me">
    <dc:subject><rdf:Bag><rdf:li>existing-keyword</rdf:li></rdf:Bag></dc:subject>
    <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Title</rdf:li><rdf:li xml:lang="fr">Titre</rdf:li></rdf:Alt></dc:title>
    <dc:creator><rdf:Seq><rdf:li>Alice</rdf:li><rdf:li>Bob</rdf:li></rdf:Seq></dc:creator>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

const clearPrefKeys = (): void => {
  for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
};

class ApiStub {
  getXmpResult: Observable<string | null> = of(SIDECAR_XML);
  getXmp = vi.fn((_path: string) => this.getXmpResult);
  putXmp = vi.fn((_path: string, xml: string) => of(xml));
  listFolders = vi.fn(() => of([LIBRARY]));
}

class NoopSidecarCache {
  get = vi.fn(async () => null);
  put = vi.fn(async () => undefined);
  delete = vi.fn(async () => undefined);
}

describe('XmpAdjustmentRestoreService batch metadata sync (#5295)', () => {
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
        provideSelfHostedWorkspace(),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
        { provide: BunApiBackendService, useValue: api },
        { provide: SIDECAR_CACHE, useValue: new NoopSidecarCache() },
        {
          provide: FolderAccessService,
          useValue: {
            listEntries: fsAccessListEntries,
            readFile: fsAccessReadFile,
            writeFile: fsAccessWriteFile,
          },
        },
      ],
    });

    state = TestBed.inject(LibraryStateService);
    store = TestBed.inject(LibraryStore);
  });

  afterEach(() => {
    clearPrefKeys();
    vi.useRealTimers();
  });

  const flushAsync = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    TestBed.tick();
  };

  it('refreshes culling and keywords in Preview after a batch metadata apply (#5295)', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'maple-batch-metadata-5295-'));
    const rawsDir = join(root, 'raws');
    const sidecarPathFor = (rawPath: string): string => rawPath.replace(/\.[^./]+$/, '.xmp');
    try {
      await fs.mkdir(rawsDir, { recursive: true });
      const firstRawPath = join(rawsDir, 'test_0004.fff');
      const secondRawPath = join(rawsDir, 'test_0008.RAF');
      await fs.writeFile(sidecarPathFor(firstRawPath), SIDECAR_XML, 'utf8');
      await fs.writeFile(sidecarPathFor(secondRawPath), SIDECAR_XML, 'utf8');

      const tempLibrary: ApiFolder = { ...LIBRARY, path: root };
      store.registeredFolders.set([tempLibrary]);
      api.listFolders.mockReturnValue(of([tempLibrary]));
      api.getXmp.mockImplementation((rawPath: string) =>
        from(fs.readFile(sidecarPathFor(rawPath), 'utf8')),
      );
      api.putXmp.mockImplementation((rawPath: string, xml: string) =>
        from(fs.writeFile(sidecarPathFor(rawPath), xml, 'utf8').then(() => xml)),
      );

      const parser = TestBed.inject(XmpParserService);
      const serializer = TestBed.inject(XmpSerializerService);
      const xmpStore = TestBed.inject(XmpStoreService);
      const restore = TestBed.inject(XmpAdjustmentRestoreService);

      state.hydrateSelfHostedFsAsset(ASSET_ID);
      state.hydrateSelfHostedFsAsset(NON_FOCUSED_ASSET_ID);

      state.selectAsset(ASSET_ID);
      TestBed.tick();
      await vi.waitFor(() => expect(api.getXmp).toHaveBeenCalledTimes(1));
      state.selectAsset(NON_FOCUSED_ASSET_ID);
      TestBed.tick();
      await vi.waitFor(() => expect(api.getXmp).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(xmpStore.metadataFor(NON_FOCUSED_ASSET_ID)).toMatchObject({ title: 'Title' }),
      );

      const writeBatchSidecarToDisk = async (
        rawPath: string,
        patch: BatchApplyMetadata,
      ): Promise<void> => {
        const existingXml = await fs.readFile(sidecarPathFor(rawPath), 'utf8');
        const parsed = parser.parseAdjustmentModel(existingXml);
        const culling = parser.parseCulling(existingXml);
        const nextCulling = {
          rating: patch.rating !== undefined ? (patch.rating ?? 0) : culling.rating,
          flag: patch.flag !== undefined ? (patch.flag ?? 'unflagged') : culling.flag,
          colorLabel: patch.colorLabel !== undefined ? patch.colorLabel : culling.colorLabel,
          keywords:
            patch.keywords !== undefined
              ? patch.keywords
                ? [...patch.keywords]
                : []
              : culling.keywords,
        };
        const nextMetadata = {
          ...parsed.metadata,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.city !== undefined ? { city: patch.city } : {}),
        };
        const updatedXml = serializer.serialize(
          { ...defaultAdjustmentModel(), ...parsed.model },
          parsed.passthrough,
          nextCulling,
          nextMetadata,
        );
        await fs.writeFile(sidecarPathFor(rawPath), updatedXml, 'utf8');
      };

      const batchPatch: BatchApplyMetadata = {
        rating: 4,
        keywords: ['batchqa'],
        title: 'Batch QA',
      };
      await writeBatchSidecarToDisk(firstRawPath, batchPatch);
      await writeBatchSidecarToDisk(secondRawPath, batchPatch);

      restore.applyBatchMetadata(
        [
          { address: ASSET_ID, metadata: batchPatch },
          { address: NON_FOCUSED_ASSET_ID, metadata: batchPatch },
        ],
        [
          { address: ASSET_ID, ok: true },
          { address: NON_FOCUSED_ASSET_ID, ok: true },
        ],
      );
      await flushAsync();

      expect(api.getXmp).toHaveBeenCalledTimes(3);
      for (const rawPath of [firstRawPath, secondRawPath]) {
        const diskXml = await fs.readFile(sidecarPathFor(rawPath), 'utf8');
        expect(parser.parseCulling(diskXml)).toMatchObject({
          rating: 4,
          keywords: ['batchqa'],
        });
        expect(parser.parseMetadata(diskXml)).toMatchObject({
          title: 'Batch QA',
        });
      }
      expect(xmpStore.metadataFor(NON_FOCUSED_ASSET_ID)).toMatchObject({ title: 'Batch QA' });
      expect(store.findAsset(NON_FOCUSED_ASSET_ID)).toMatchObject({
        rating: 4,
        keywords: ['batchqa'],
        title: 'Batch QA',
        edited: true,
      });
      expect(store.findAsset(ASSET_ID)).toMatchObject({
        rating: 4,
        keywords: ['batchqa'],
        title: 'Batch QA',
        edited: true,
      });

      state.selectAsset(ASSET_ID);
      TestBed.tick();
      await vi.waitFor(() =>
        expect(xmpStore.metadataFor(ASSET_ID)).toMatchObject({ title: 'Batch QA' }),
      );
      expect(api.getXmp).toHaveBeenCalledTimes(4);
      expect(store.findAsset(ASSET_ID)).toMatchObject({
        rating: 4,
        keywords: ['batchqa'],
        title: 'Batch QA',
      });

      const librarySource = TestBed.inject(LIBRARY_SOURCE);
      vi.spyOn(librarySource, 'listFolder').mockResolvedValue({
        address: 'photos:raws',
        parent: 'photos:',
        folders: [],
        images: [
          { address: ASSET_ID, name: 'test_0004.fff', mapleId: 'm1', indexed: true, rating: 0 },
          {
            address: NON_FOCUSED_ASSET_ID,
            name: 'test_0008.RAF',
            mapleId: 'm2',
            indexed: true,
            rating: 0,
          },
        ],
      } satisfies FolderListing);
      store.assets.update((list) => list.map((a) => ({ ...a, folderId: 'photos:raws' })));
      state.openSelfHostedSubfolder('raws', 'photos:raws');
      await flushAsync();
      expect(store.findAsset(ASSET_ID)).toMatchObject({
        rating: 4,
        keywords: ['batchqa'],
        edited: true,
      });

      const clearKeywordsPatch: BatchApplyMetadata = { keywords: null };
      await writeBatchSidecarToDisk(firstRawPath, clearKeywordsPatch);
      restore.applyBatchMetadata(
        [{ address: ASSET_ID, metadata: clearKeywordsPatch }],
        [{ address: ASSET_ID, ok: true }],
      );
      await flushAsync();
      expect(store.findAsset(ASSET_ID)?.keywords).toEqual([]);
      const clearedDiskXml = await fs.readFile(sidecarPathFor(firstRawPath), 'utf8');
      expect(parser.parseCulling(clearedDiskXml).keywords).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('preserves a selected sibling workflow variant when batch metadata writes the primary sidecar', async () => {
    const synth = state.hydrateSelfHostedFsAsset(ASSET_ID);
    expect(synth).not.toBeNull();
    state.selectAsset(ASSET_ID);
    TestBed.tick();
    await flushAsync();
    expect(api.getXmp).toHaveBeenCalledTimes(1);

    const absPath = store.absPathFor(ASSET_ID)!;
    store.workflowVariants.bind(ASSET_ID, absPath, 'v-sibling');

    const restore = TestBed.inject(XmpAdjustmentRestoreService);
    restore.applyBatchMetadata(
      [{ address: ASSET_ID, metadata: { rating: 5, keywords: ['primary-only'] } }],
      [{ address: ASSET_ID, ok: true }],
    );
    await flushAsync();

    expect(api.getXmp).toHaveBeenCalledTimes(1);
    expect(store.findAsset(ASSET_ID)).toMatchObject({
      rating: 3,
      keywords: ['existing-keyword'],
    });
    expect(store.cullingPatchFor(ASSET_ID)).toEqual({});
  });
});
