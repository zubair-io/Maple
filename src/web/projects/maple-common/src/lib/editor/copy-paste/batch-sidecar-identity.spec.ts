// A Browse-mode batch always targets the Primary sidecar it was created
// for, even while the editor still holds a sibling variant bound for that
// asset (#4682). The variant converter is the real Rust WASM module, called
// in-process because vitest's jsdom has no Worker.
import { promises as fs, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  initSync,
  workflow_checkpoint_xmp,
  workflow_commit_xmp,
  workflow_embed_xmp,
  workflow_read_xmp,
  workflow_restore_xmp,
  workflow_snapshot_xmp,
  workflow_variant_filename,
} from '../../raw-pipeline/pkg/raw_wasm';
import { provideHostedWorkspace } from '../../workspace/hosted-workspace.providers';
import { FolderAccessService } from '../../folder-access/folder-access.service';
import {
  fsAccessReadFile,
  fsAccessWriteFile,
  fsAccessEnsureSubdirectory,
  fsAccessListEntries,
} from '../../folder-access/fs-access-backend';
import type { MapleFolderHandle } from '../../folder-access/folder-access.types';
import { LibraryStateService } from '../../state/library-state.service';
import { LibraryStore } from '../../state/library-store.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { XmpParserService } from '../../xmp/xmp-parser.service';
import { XmpStoreService } from '../../xmp/xmp-store.service';
import { WorkflowXmpService } from '../../xmp/workflow-xmp.service';
import {
  PRIMARY_VARIANT_ID,
  parseSidecarWorkflow,
  type SidecarWorkflow,
  type WorkflowHistoryEntry,
  type WorkflowSnapshot,
} from '../../generated/workflow.generated';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import type { Asset } from '../../models/asset';
import { newBatchOperation, type BatchOperation } from './batch-ledger';
import { PersistentBatchRunner } from './persistent-batch-runner';
import { BatchSyncAssetIO } from './batch-sync-asset-io.service';
import { DiskBatchLedger, DiskDirectory } from './testing/batch-test-files';

const image = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
);
const VARIANT_B = '0f4e2b6a-7c3d-4e5f-8a9b-0c1d2e3f4a5b';
const primaryCulling = {
  rating: 4,
  flag: 'pick' as const,
  colorLabel: 'green' as const,
  keywords: ['primary'],
};
const variantCulling = {
  rating: 1,
  flag: 'reject' as const,
  colorLabel: 'red' as const,
  keywords: ['variant'],
};
const primaryPassthrough = {
  unknownAttributes: [{ name: 'vendor:Keep', value: 'yes' }],
  unknownNamespaces: [{ prefix: 'vendor', uri: 'https://example.test/' }],
  unknownNodes: [],
};
const variantModel = () => ({ ...defaultAdjustmentModel(), saturation: 40, clarity: 15 });
const workflowB: SidecarWorkflow = {
  schemaVersion: 1,
  variantId: VARIANT_B,
  variantName: 'B',
  snapshots: [],
  history: [],
};

/** The worker's operations, run on the same Rust module without a Worker. */
class InProcessWorkflowXmp {
  async read(xmp: string): Promise<SidecarWorkflow | null> {
    const value: unknown = JSON.parse(workflow_read_xmp(xmp));
    return value === null ? null : parseSidecarWorkflow(value);
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
  async variantFilename(primaryName: string, variantId: string): Promise<string> {
    return workflow_variant_filename(primaryName, variantId);
  }
}

/** Web Locks serialized per name, as Chromium does for cooperating tabs. */
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

describe('batch paste with a sibling variant still bound (#4682)', () => {
  let root: string;
  let photos: string;
  let folder: MapleFolderHandle;
  let io: BatchSyncAssetIO;
  let ledger: DiskBatchLedger;
  let store: LibraryStore;
  let library: LibraryStateService;
  let xmpStore: XmpStoreService;
  let asset: Asset;
  const parser = new XmpParserService();
  const serializer = new XmpSerializerService();
  const variantFile = `a.v${VARIANT_B}.xmp`;
  const read = (name: string) => fs.readFile(join(photos, name), 'utf8');

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
    root = await fs.mkdtemp(join(tmpdir(), 'maple-batch-variant-'));
    photos = join(root, 'photos');
    await fs.mkdir(photos);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideHostedWorkspace(),
        { provide: WorkflowXmpService, useClass: InProcessWorkflowXmp },
        {
          provide: FolderAccessService,
          useValue: {
            readFile: fsAccessReadFile,
            writeFile: fsAccessWriteFile,
            ensureSubdirectory: fsAccessEnsureSubdirectory,
            listEntries: fsAccessListEntries,
          },
        },
      ],
    });
    store = TestBed.inject(LibraryStore);
    library = TestBed.inject(LibraryStateService);
    xmpStore = TestBed.inject(XmpStoreService);
    io = TestBed.inject(BatchSyncAssetIO);
    asset = {
      id: 'photos:a',
      filename: 'a.png',
      folderId: 'f-photos',
      ...primaryCulling,
      thumbnailGradient: '',
      aspectRatio: 1,
    };
    folder = {
      name: 'photos',
      read: true,
      write: true,
      persistedKey: photos,
      native: new DiskDirectory(photos) as unknown as FileSystemDirectoryHandle,
    };
    store.assets.set([asset]);
    store.currentFolder.set(folder);
    await fs.writeFile(join(photos, 'a.png'), image);
    await fs.writeFile(join(photos, 'b.png'), image);
    await fs.writeFile(
      join(photos, 'a.xmp'),
      serializer.serialize(
        { ...defaultAdjustmentModel(), saturation: 0, sharpenAmount: 33 },
        primaryPassthrough,
        primaryCulling,
        { title: 'Primary title', headline: 'Primary headline' },
      ),
    );
    await fs.writeFile(join(photos, 'b.xmp'), serializer.serialize(defaultAdjustmentModel()));
    await fs.writeFile(
      join(photos, variantFile),
      workflow_embed_xmp(
        JSON.stringify(workflowB),
        serializer.serialize(variantModel(), undefined, variantCulling),
      ),
    );
    ledger = new DiskBatchLedger(join(root, 'ledger'));
    expect(library.backend).toBe('hosted');
  });
  afterEach(async () => {
    TestBed.resetTestingModule();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function selectVariantB(): Promise<void> {
    const selected = await xmpStore.bindVariant(asset.id, folder, asset.filename, VARIANT_B);
    store.markSessionEdited(asset.id);
    store.setAdjustment(asset.id, { ...defaultAdjustmentModel(), ...selected.model });
    store.setCulling(asset.id, selected.culling);
    expect(xmpStore.bindingFor(asset.id, folder, asset.filename).variantId).toBe(VARIANT_B);
  }
  function toneBatch(): ReturnType<typeof newBatchOperation> {
    return newBatchOperation({
      libraryId: photos,
      directory: folder.native,
      assets: [asset],
      request: {
        source: { ...defaultAdjustmentModel(), exposure: 1.25, highlights: -30 },
        groups: ['tone'],
        relativeWhiteBalance: false,
      },
      patch: { exposure: 1.25, highlights: -30 },
    });
  }
  const runner = () =>
    new PersistentBatchRunner(ledger, {
      prepare: io.prepare.bind(io),
      write: io.write.bind(io),
      changed: () => {},
    });

  it('pastes Tone into the Primary sidecar and leaves the bound variant byte-identical', async () => {
    await selectVariantB();
    const variantBefore = await read(variantFile);
    const operation = toneBatch();
    expect(operation.targets[asset.id]).toEqual({
      rawFilename: 'a.png',
      filename: 'a.xmp',
      variantId: PRIMARY_VARIANT_ID,
    });
    await ledger.create(operation);

    const result = await runner().run(operation.id);
    expect(result.summary).toMatchObject({ applied: [asset.id], failed: [] });

    const primary = await read('a.xmp');
    expect(parser.parseAdjustmentModel(primary).model).toMatchObject({
      exposure: 1.25,
      highlights: -30,
      sharpenAmount: 33,
    });
    expect(parser.parseAdjustmentModel(primary).model.saturation ?? 0).toBe(0);
    expect(parser.parseAdjustmentModel(primary).model.clarity ?? 0).toBe(0);
    expect(primary).toContain('vendor:Keep="yes"');
    expect(parser.parseMetadata(primary)).toMatchObject({
      title: 'Primary title',
      headline: 'Primary headline',
    });
    expect(parser.parseCulling(primary)).toMatchObject(primaryCulling);
    expect(primary).not.toContain('Workflow');

    expect(await read(variantFile)).toBe(variantBefore);
    expect(library.adjustmentFor(asset.id)()).toMatchObject({
      saturation: 40,
      clarity: 15,
      exposure: 0,
    });
    expect(xmpStore.bindingFor(asset.id, folder, asset.filename).variantId).toBe(VARIANT_B);
  });

  it('pastes into the Primary sidecar and the live model when no variant is bound', async () => {
    const operation = toneBatch();
    await ledger.create(operation);
    expect((await runner().run(operation.id)).summary.applied).toEqual([asset.id]);
    expect(parser.parseAdjustmentModel(await read('a.xmp')).model).toMatchObject({
      exposure: 1.25,
      sharpenAmount: 33,
    });
    expect(library.adjustmentFor(asset.id)()).toMatchObject({ exposure: 1.25, highlights: -30 });
  });

  it.each([
    ['another sidecar file', { rawFilename: 'a.png', filename: 'b.xmp', variantId: 'primary' }],
    [
      'a variant under the primary name',
      { rawFilename: 'a.png', filename: 'a.xmp', variantId: VARIANT_B },
    ],
    ['another original', { rawFilename: 'b.png', filename: 'b.xmp', variantId: 'primary' }],
  ])('refuses a ledger target that names %s and writes nothing', async (_label, target) => {
    const operation = { ...toneBatch(), targets: { [asset.id]: target } };
    await ledger.create(operation);
    const before = await Promise.all([read('a.xmp'), read('b.xmp'), read(variantFile)]);

    const result = await runner().run(operation.id);
    expect(result.summary.applied).toEqual([]);
    expect(result.summary.failed).toEqual([
      { id: asset.id, reason: expect.stringContaining('prepared for a different sidecar') },
    ]);
    expect(await Promise.all([read('a.xmp'), read('b.xmp'), read(variantFile)])).toEqual(before);
  });

  it('treats a ledger written before targets existed as Primary-targeted', async () => {
    await selectVariantB();
    const variantBefore = await read(variantFile);
    const { targets: _legacy, ...operation } = toneBatch();
    await ledger.create(operation as BatchOperation);

    expect((await runner().run(operation.id)).summary.applied).toEqual([asset.id]);
    expect(parser.parseAdjustmentModel(await read('a.xmp')).model.exposure).toBe(1.25);
    expect(await read(variantFile)).toBe(variantBefore);
  });
});
