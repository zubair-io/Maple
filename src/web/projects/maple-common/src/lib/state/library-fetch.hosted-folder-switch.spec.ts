// Hosted openFolder across two writable folders holding same-named RAWs (#4683).
//
// Switching folders must drop the previous folder's focus, and a culling edit
// addressed to a stale asset must never be serialized into the newly opened
// folder's same-basename sidecar. Both folders are real temp directories with
// real sidecars; only the OS directory handle is adapted to the test's dirs.

import { promises as fs, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initSync,
  workflow_checkpoint_xmp,
  workflow_commit_xmp,
  workflow_embed_xmp,
  workflow_read_xmp,
  workflow_restore_xmp,
  workflow_snapshot_xmp,
  workflow_variant_filename,
} from '../raw-pipeline/pkg/raw_wasm';
import { provideHostedWorkspace } from '../workspace/hosted-workspace.providers';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { FolderAccessService } from '../folder-access/folder-access.service';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import {
  fsAccessEnsureSubdirectory,
  fsAccessListEntries,
  fsAccessReadFile,
  fsAccessWriteFile,
} from '../folder-access/fs-access-backend';
import { DiskDirectory } from '../editor/copy-paste/testing/batch-test-files';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { WorkflowVariantStoreService } from '../xmp/workflow-variant-store.service';
import { WorkflowXmpService } from '../xmp/workflow-xmp.service';
import {
  parseSidecarWorkflow,
  type SidecarWorkflow,
  type WorkflowHistoryEntry,
  type WorkflowSnapshot,
} from '../generated/workflow.generated';
import { SidecarSaveStateService } from '../xmp/sidecar-save-state.service';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import { LibraryStateService } from './library-state.service';

const RAW_BYTES = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0xde, 0xad, 0xbe, 0xef]);
const NO_CULLING = { rating: 0, flag: 'unflagged' as const, colorLabel: null, keywords: [] };

/** Run the real Rust workflow parser in-process; jsdom has no Worker. */
class InProcessWorkflowXmp {
  async read(xmp: string): Promise<SidecarWorkflow | null> {
    const value: unknown = JSON.parse(workflow_read_xmp(xmp));
    return value === null ? null : parseSidecarWorkflow(value);
  }

  async variantFilename(primaryName: string, variantId: string): Promise<string> {
    return workflow_variant_filename(primaryName, variantId);
  }

  async embed(workflow: SidecarWorkflow, xmp: string): Promise<string> {
    return workflow_embed_xmp(JSON.stringify(parseSidecarWorkflow(workflow)), xmp);
  }

  async commit(entry: WorkflowHistoryEntry, xmp: string): Promise<string> {
    return workflow_commit_xmp(xmp, JSON.stringify(entry));
  }

  async snapshot(snapshot: WorkflowSnapshot, xmp: string): Promise<string> {
    return workflow_snapshot_xmp(xmp, JSON.stringify(snapshot));
  }

  async restore(entry: WorkflowHistoryEntry, xmp: string): Promise<string> {
    return workflow_restore_xmp(xmp, JSON.stringify(entry));
  }

  async checkpoint(xmp: string): Promise<string> {
    return workflow_checkpoint_xmp(xmp);
  }
}

/** Serialize named Web Locks as Chromium does for cooperating tabs. */
function inProcessLocks(): LockManager {
  const chains = new Map<string, Promise<unknown>>();
  const request = (name: string, ...rest: unknown[]) => {
    const callback = rest.find((arg) => typeof arg === 'function') as (
      lock: Lock | null,
    ) => Promise<unknown>;
    const prior = chains.get(name) ?? Promise.resolve();
    const run = prior.then(
      () => callback({ name, mode: 'exclusive' }),
      () => callback({ name, mode: 'exclusive' }),
    );
    chains.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  };
  return { request, query: async () => ({ held: [], pending: [] }) } as unknown as LockManager;
}

describe('Hosted openFolder with a stale focused asset (#4683)', () => {
  const serializer = new XmpSerializerService();
  const writeFile = vi.fn(fsAccessWriteFile);
  let root: string;
  let folderA: MapleFolderHandle;
  let folderB: MapleFolderHandle;
  let library: LibraryStateService;

  const folderHandle = (path: string, name: string): MapleFolderHandle => ({
    name,
    read: true,
    write: true,
    persistedKey: path,
    native: new DiskDirectory(path) as unknown as FileSystemDirectoryHandle,
  });

  const stageFolder = async (name: string, exposure: number): Promise<MapleFolderHandle> => {
    const path = join(root, name);
    await fs.mkdir(path);
    await fs.writeFile(join(path, 'photo.dng'), RAW_BYTES);
    const xml = serializer.serialize(
      { ...defaultAdjustmentModel(), exposure },
      undefined,
      NO_CULLING,
    );
    await fs.writeFile(join(path, 'photo.xmp'), xml);
    return folderHandle(path, name);
  };

  const sidecarBytes = (folder: MapleFolderHandle): Promise<Buffer> =>
    fs.readFile(join(folder.persistedKey!, 'photo.xmp'));

  beforeAll(() => {
    initSync({
      module: readFileSync(
        resolve(process.cwd(), 'projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm_bg.wasm'),
      ),
    });
    Object.defineProperty(navigator, 'locks', { value: inProcessLocks(), configurable: true });
  });

  afterAll(() => {
    Reflect.deleteProperty(navigator, 'locks');
  });

  beforeEach(async () => {
    writeFile.mockClear();
    root = await fs.mkdtemp(join(tmpdir(), 'maple-folder-switch-'));
    folderA = await stageFolder('a', 2);
    folderB = await stageFolder('b', -1);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideHostedWorkspace(),
        { provide: LIBRARY_BACKEND, useValue: 'hosted' },
        { provide: WorkflowXmpService, useClass: InProcessWorkflowXmp },
        {
          provide: FolderAccessService,
          useValue: {
            readFile: fsAccessReadFile,
            writeFile,
            ensureSubdirectory: fsAccessEnsureSubdirectory,
            listEntries: fsAccessListEntries,
          },
        },
      ],
    });
    library = TestBed.inject(LibraryStateService);
    await library.openFolder(folderA);
    library.selectAsset('a:photo.dng');
    expect(library.focusedAssetId()).toBe('a:photo.dng');
    expect(library.adjustmentModels().get('a:photo.dng')?.exposure).toBe(2);
  });

  afterEach(async () => {
    TestBed.resetTestingModule();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('drops the previous folder focus and selection when a different folder opens', async () => {
    await library.openFolder(folderB);

    expect(library.selectedSourceId()).toBe('f-b');
    expect(library.focusedAssetId()).toBeNull();
    expect(library.selectedCount()).toBe(0);
    expect(library.adjustmentModels().get('b:photo.dng')?.exposure).toBe(-1);
  });

  it('refuses to write a stale asset edit into the open folder same-basename sidecar', async () => {
    const originalA = await sidecarBytes(folderA);
    const originalB = await sidecarBytes(folderB);
    await library.openFolder(folderB);

    library.setRating('a:photo.dng', 5);
    await TestBed.inject(XmpStoreService).settleAsset('a:photo.dng');

    expect(await sidecarBytes(folderB)).toEqual(originalB);
    expect(await sidecarBytes(folderA)).toEqual(originalA);
    expect(writeFile).not.toHaveBeenCalledWith(folderB, 'photo.xmp', expect.anything());
    expect(TestBed.inject(SidecarSaveStateService).phase()).toBe('error');
  });

  it('publishes a pending edit before switching away and reloads it on return', async () => {
    library.updateAdjustment('a:photo.dng', { exposure: 3 });

    await library.openFolder(folderB);
    await library.openFolder(folderA);

    expect(library.adjustmentModels().get('a:photo.dng')?.exposure).toBe(3);
    const saved = new TextDecoder().decode(await sidecarBytes(folderA));
    expect(TestBed.inject(XmpParserService).parseAdjustmentModel(saved).model.exposure).toBe(3);
  });

  it('keeps the edited folder active when its pending sidecar cannot be saved', async () => {
    library.updateAdjustment('a:photo.dng', { exposure: 3 });
    writeFile.mockRejectedValueOnce(new Error('Permission revoked'));

    await expect(library.openFolder(folderB)).rejects.toThrow('Permission revoked');

    expect(library.currentFolder()).toBe(folderA);
    expect(library.adjustmentModels().get('a:photo.dng')?.exposure).toBe(3);
    expect(library.selectedSourceId()).toBe('f-a');
  });

  it('reloads the selected variant model instead of primary under its retained binding', async () => {
    const variantId = '0f4e2b6a-7c3d-4e5f-8a9b-0c1d2e3f4a5b';
    const variantXml = workflow_embed_xmp(
      JSON.stringify({
        schemaVersion: 1,
        variantId,
        variantName: 'Edited',
        snapshots: [],
        history: [],
      } satisfies SidecarWorkflow),
      serializer.serialize({ ...defaultAdjustmentModel(), exposure: 4 }),
    );
    await fs.writeFile(join(folderA.persistedKey!, `photo.v${variantId}.xmp`), variantXml);
    const xmpStore = TestBed.inject(XmpStoreService);
    const variants = TestBed.inject(WorkflowVariantStoreService);
    expect(await variants.read(folderA, 'photo.xmp', variantId)).toBe(variantXml);
    await xmpStore.bindVariant('a:photo.dng', folderA, 'photo.dng', variantId);

    await library.openFolder(folderB);
    await library.openFolder(folderA);

    expect(xmpStore.bindingFor('a:photo.dng', folderA, 'photo.dng').variantId).toBe(variantId);
    expect(library.adjustmentModels().get('a:photo.dng')?.exposure).toBe(4);
    const primary = new TextDecoder().decode(await sidecarBytes(folderA));
    expect(TestBed.inject(XmpParserService).parseAdjustmentModel(primary).model.exposure).toBe(2);
  });
});
