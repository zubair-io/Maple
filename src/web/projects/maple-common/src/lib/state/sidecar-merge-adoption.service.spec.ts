// The live editor shows the document a stale save merged into, so a stale
// in-memory model can never overwrite that merge on its next save (#4983).
import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiskDirectory } from '../editor/copy-paste/testing/batch-test-files';
import { FolderAccessService } from '../folder-access/folder-access.service';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import {
  fsAccessListEntries,
  fsAccessReadFile,
  fsAccessWriteFile,
} from '../folder-access/fs-access-backend';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { Asset } from '../models/asset';
import { initSync } from '../raw-pipeline/pkg/raw_wasm';
import { provideHostedWorkspace } from '../workspace/hosted-workspace.providers';
import { inProcessWorkflowXmp } from '../xmp/testing/in-process-workflow-xmp';
import { WorkflowXmpService } from '../xmp/workflow-xmp.service';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { LibraryFetch } from './library-fetch.service';
import { LibraryStore } from './library-store.service';

const culling = { rating: 1, flag: 'unflagged' as const, colorLabel: null, keywords: [] };

describe('live model adoption of a merged save', () => {
  const parser = new XmpParserService();
  const serializer = new XmpSerializerService();
  const asset: Asset = {
    id: 'photos:a',
    filename: 'a.png',
    folderId: 'f-photos',
    ...culling,
    thumbnailGradient: '',
    aspectRatio: 1,
  };
  let root: string;
  let folder: MapleFolderHandle;
  let library: LibraryStore;
  let xmpStore: XmpStoreService;
  let duringRead: (() => void) | undefined;
  let writeFile: ReturnType<typeof vi.fn<typeof fsAccessWriteFile>>;
  const path = () => join(root, 'a.xmp');
  const onDisk = async () => parser.parseAdjustmentModel(await fs.readFile(path(), 'utf8')).model;
  const live = () => library.adjustmentFor(asset.id)();
  const save = (patch: object) => {
    library.setAdjustment(asset.id, patch);
    xmpStore.scheduleWrite(
      asset.id,
      folder,
      asset.filename,
      { ...defaultAdjustmentModel(), ...live() },
      culling,
    );
  };

  beforeAll(() => {
    initSync({
      module: readFileSync(
        resolve(process.cwd(), 'projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm_bg.wasm'),
      ),
    });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: async (_name: string, write: () => Promise<string>) => write() },
    });
  });
  afterAll(() => {
    Reflect.deleteProperty(navigator, 'locks');
  });
  beforeEach(async () => {
    duringRead = undefined;
    root = await fs.mkdtemp(join(tmpdir(), 'maple-adopt-'));
    const initial = serializer.serialize(defaultAdjustmentModel(), undefined, culling);
    await fs.writeFile(path(), initial);
    writeFile = vi.fn(fsAccessWriteFile);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideHostedWorkspace(),
        { provide: WorkflowXmpService, useValue: inProcessWorkflowXmp },
        {
          provide: FolderAccessService,
          useValue: {
            listEntries: fsAccessListEntries,
            readFile: async (...args: Parameters<typeof fsAccessReadFile>) => {
              const result = await fsAccessReadFile(...args);
              const action = duringRead;
              duringRead = undefined;
              action?.();
              return result;
            },
            writeFile,
          },
        },
      ],
    });
    library = TestBed.inject(LibraryStore);
    xmpStore = TestBed.inject(XmpStoreService);
    TestBed.inject(LibraryFetch);
    folder = {
      name: 'photos',
      read: true,
      write: true,
      native: new DiskDirectory(root) as unknown as FileSystemDirectoryHandle,
    };
    library.assets.set([asset]);
    library.currentFolder.set(folder);
    library.setAdjustment(asset.id, defaultAdjustmentModel());
    xmpStore.replaceLoadedDocuments(folder, new Map([['a.xmp', initial]]));
    await fs.writeFile(
      path(),
      serializer.serialize({ ...defaultAdjustmentModel(), exposure: 1.5 }, undefined, culling),
    );
  });
  afterEach(async () => {
    TestBed.resetTestingModule();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('shows the merged document without saving again, and keeps it on the next save', async () => {
    save({ contrast: 20 });
    await xmpStore.flushAll();

    expect(live()).toMatchObject({ exposure: 1.5, contrast: 20 });
    expect(await onDisk()).toMatchObject({ exposure: 1.5, contrast: 20 });
    expect(writeFile).toHaveBeenCalledTimes(1);

    save({ highlights: -10 });
    await xmpStore.flushAll();
    expect(await onDisk()).toMatchObject({ exposure: 1.5, contrast: 20, highlights: -10 });
  });

  it('keeps an edit made while the merging save was in flight', async () => {
    save({ contrast: 20 });
    duringRead = () => save({ highlights: -30 });
    await xmpStore.flushAll();
    await xmpStore.flushAsset(asset.id);

    expect(live()).toMatchObject({ exposure: 1.5, contrast: 20, highlights: -30 });
    expect(await onDisk()).toMatchObject({ exposure: 1.5, contrast: 20, highlights: -30 });
  });
});
