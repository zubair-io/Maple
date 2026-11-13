// Undo/Redo and restore entries carry the Web writer label and the head of the
// record they were based on, and the commands rebuild the ring a reopened editor
// starts with (#4983). Real sidecar files and the real Rust workflow module.
import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { LibraryStore } from '../state/library-store.service';
import { provideHostedWorkspace } from '../workspace/hosted-workspace.providers';
import { inProcessWorkflowXmp } from '../xmp/testing/in-process-workflow-xmp';
import { WorkflowXmpService } from '../xmp/workflow-xmp.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { DiskDirectory } from './copy-paste/testing/batch-test-files';
import { EditorWorkflowCommandsService } from './editor-workflow-commands.service';

const culling = { rating: 1, flag: 'unflagged' as const, colorLabel: null, keywords: [] };

describe('workflow commands lineage', () => {
  const core = inProcessWorkflowXmp;
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
  let xmpStore: XmpStoreService;
  let commands: EditorWorkflowCommandsService;
  const history = async () =>
    (await core.read(await fs.readFile(join(root, 'a.xmp'), 'utf8')))!.history;
  const commit = (contrast: number) =>
    xmpStore.commitSemantic(
      asset.id,
      folder,
      asset.filename,
      { ...defaultAdjustmentModel(), contrast },
      culling,
      'adjustment',
      `Contrast ${contrast}`,
    );

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
    root = await fs.mkdtemp(join(tmpdir(), 'maple-commands-'));
    const initial = serializer.serialize(defaultAdjustmentModel(), undefined, culling);
    await fs.writeFile(join(root, 'a.xmp'), initial);
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
            readFile: fsAccessReadFile,
            writeFile: fsAccessWriteFile,
          },
        },
      ],
    });
    folder = {
      name: 'photos',
      read: true,
      write: true,
      native: new DiskDirectory(root) as unknown as FileSystemDirectoryHandle,
    };
    const library = TestBed.inject(LibraryStore);
    library.assets.set([asset]);
    library.currentFolder.set(folder);
    xmpStore = TestBed.inject(XmpStoreService);
    xmpStore.replaceLoadedDocuments(folder, new Map([['a.xmp', initial]]));
    commands = TestBed.inject(EditorWorkflowCommandsService);
  });
  afterEach(async () => {
    TestBed.resetTestingModule();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('records an Undo replay as a web entry whose parent is the record head', async () => {
    await commit(10);
    await commit(20);
    const [first, second] = await history();
    const source = commands.capture(asset.id, defaultAdjustmentModel())!;

    const command = await commands.prepareReplay(
      source,
      first.adjustmentXmp,
      'undo',
      'Undo Contrast 20',
    );
    await commands.restore(command);

    const entries = await history();
    expect(entries.map((entry) => entry.action)).toEqual(['adjustment', 'adjustment', 'undo']);
    expect(entries[2]).toMatchObject({ writer: 'web', parentId: second.id });
    expect(entries[2].adjustmentXmp).toBe(first.adjustmentXmp);
  });

  it('records a restore of a retained state as a web entry with its lineage', async () => {
    await commit(10);
    await commit(20);
    const [first, second] = await history();
    const source = commands.capture(asset.id, defaultAdjustmentModel())!;
    const document = await commands.load(source);

    const command = await commands.prepareRestore(source, document, first.id);
    await commands.restore(command);

    const entries = await history();
    expect(entries.at(-1)).toMatchObject({
      action: 'history-restore',
      writer: 'web',
      parentId: second.id,
    });
  });

  it('rebuilds the ring a reopened editor starts with', async () => {
    await commit(10);
    await commit(20);
    const source = commands.capture(asset.id, defaultAdjustmentModel())!;

    const { undo, redo } = await commands.ringSteps(source);

    expect(undo.map((step) => step.description)).toEqual(['Contrast 20']);
    expect(undo[0].after.contrast).toBe(20);
    expect(redo).toEqual([]);
  });

  it('offers no steps for a sidecar without a record', async () => {
    const source = commands.capture(asset.id, defaultAdjustmentModel())!;
    expect(await commands.ringSteps(source)).toEqual({ undo: [], redo: [] });
  });
});
