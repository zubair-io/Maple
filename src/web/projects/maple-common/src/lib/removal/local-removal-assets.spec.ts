import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { computed } from '@angular/core';
import { LibraryStateService } from '../state/library-state.service';
import { SavedRemovalRenderService } from './saved-removal-render.service';
import { savedRemovalRecords } from './saved-removal-records';
import { TestBed } from '@angular/core/testing';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  initSync,
  workflow_read_xmp,
  workflow_variant_filename,
  workflow_embed_xmp,
  workflow_checkpoint_xmp,
  workflow_commit_xmp,
} from '../raw-pipeline/pkg/raw_wasm';
import { WorkflowXmpService } from '../xmp/workflow-xmp.service';
import { HostedWorkflowWriterService } from '../xmp/hosted-workflow-writer.service';
import type { SidecarWorkflow, WorkflowHistoryEntry } from '../generated/workflow.generated';
import { DiskDirectory } from '../editor/copy-paste/testing/batch-test-files';
import {
  fsAccessReadFile,
  fsAccessWriteFile,
  fsAccessListEntries,
} from '../folder-access/fs-access-backend';
import { FolderAccessService } from '../folder-access/folder-access.service';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { SidecarSaveStateService } from '../xmp/sidecar-save-state.service';
import { LocalRemovalAssets } from './local-removal-assets';
import { installTestWebLocks } from './testing/web-locks';

const fixtureRoot = resolve(process.cwd(), '../../test-fixtures/removal/basic');
const fixture = (name: string) => new Uint8Array(readFileSync(join(fixtureRoot, name)));
const text = (name: string) => new TextDecoder().decode(fixture(name));
const culling = { rating: 0, flag: 'unflagged' as const, colorLabel: null };

describe('durable browser removal through actual WASM and filesystem files', () => {
  let root: string;
  let folder: MapleFolderHandle;
  let assets: LocalRemovalAssets;
  let sidecars: XmpStoreService;
  const publish = () =>
    assets.publish(text('request.txt'), '[]', fixture('mask.mimf'), fixture('patch.f16'));
  const commit = (records: string, expected = '[]') =>
    sidecars.writeRemovalConfirmed(
      'photo',
      folder,
      'photo.dng',
      defaultAdjustmentModel(),
      culling,
      expected,
      records,
    );

  beforeAll(() => {
    initSync({
      module: readFileSync(
        resolve(process.cwd(), 'projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm_bg.wasm'),
      ),
    });
    // Use Node's native LockManager or Bun's serial test fallback.
    installTestWebLocks();
  });
  beforeEach(async () => {
    TestBed.resetTestingModule();
    root = await fs.mkdtemp(join(tmpdir(), 'maple-removal-'));
    await fs.writeFile(join(root, 'photo.dng'), fixture('source.dng'));
    await fs.writeFile(join(root, 'photo.xmp'), fixture('prior.xmp'));
    folder = {
      name: root,
      read: true,
      write: true,
      native: new DiskDirectory(root) as unknown as FileSystemDirectoryHandle,
    };
    TestBed.configureTestingModule({
      providers: [
        // The converters are real WASM; Node has no browser Worker.
        {
          provide: WorkflowXmpService,
          useValue: {
            read: async (xml: string) => JSON.parse(workflow_read_xmp(xml)),
            variantFilename: async (name: string, id: string) =>
              workflow_variant_filename(name, id),
            embed: async (workflow: SidecarWorkflow, xml: string) =>
              workflow_embed_xmp(JSON.stringify(workflow), xml),
            checkpoint: async (xml: string) => workflow_checkpoint_xmp(xml),
            commit: async (entry: WorkflowHistoryEntry, xml: string) =>
              workflow_commit_xmp(xml, JSON.stringify(entry)),
          },
        },
        {
          provide: LibraryStateService,
          useValue: {
            focusedAsset: () => ({ id: 'photo', filename: 'photo.dng' }),
            currentFolder: () => folder,
          },
        },
        {
          provide: FolderAccessService,
          useValue: {
            readFile: fsAccessReadFile,
            writeFile: fsAccessWriteFile,
            listEntries: fsAccessListEntries,
          },
        },
      ],
    });
    sidecars = TestBed.inject(XmpStoreService);
    assets = new LocalRemovalAssets(TestBed.inject(FolderAccessService), folder, 'photo.dng');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('updates the normal render recipe only after a confirmed sidecar commit and loads its real companions', async () => {
    const renderer = TestBed.inject(SavedRemovalRenderService);
    const xml = computed(() => renderer.serialize('photo', defaultAdjustmentModel()));
    expect(savedRemovalRecords(xml())).toBeUndefined();
    const records = await publish();
    await commit(records);
    expect(savedRemovalRecords(xml())).toBe(records);
    const bundle = await renderer.load('photo', xml());
    expect(bundle).toBeDefined();
    expect(JSON.parse(bundle!.manifest)).toHaveLength(2);
    expect(bundle!.bytes.byteLength).toBe(
      fixture('mask.mimf').byteLength + fixture('patch.f16').byteLength,
    );
    const sidecar = await fs.readFile(join(root, 'photo.xmp'), 'utf8');
    expect(savedRemovalRecords(sidecar)).toBe(records);
    const names = JSON.parse(bundle!.manifest) as { name: string }[];
    await fs.rm(join(root, '.maple', 'inpaint', names[0].name));
    await expect(renderer.load('photo', xml())).rejects.toThrow();
  });

  it('binds removal and workflow writes to the named sibling without changing primary or RAW', async () => {
    const primary = await fs.readFile(join(root, 'photo.xmp'));
    const id = crypto.randomUUID();
    const filename = workflow_variant_filename('photo.xmp', id);
    const workflow: SidecarWorkflow = {
      schemaVersion: 1,
      variantId: id,
      variantName: 'Removal branch',
      snapshots: [],
      history: [],
    };
    await fs.writeFile(
      join(root, filename),
      workflow_embed_xmp(JSON.stringify(workflow), primary.toString()),
    );
    await sidecars.bindVariant('photo', folder, 'photo.dng', id);
    const records = await publish();
    const revision = await sidecars.captureRemovalRevision('photo', folder, 'photo.dng');
    await sidecars.writeRemovalConfirmed(
      'photo',
      folder,
      'photo.dng',
      defaultAdjustmentModel(),
      culling,
      '[]',
      records,
      revision,
    );
    await sidecars.writeWorkflow('photo', folder, 'photo.dng', {
      ...workflow,
      variantName: 'Removed objects',
    });
    const selected = await fs.readFile(join(root, filename), 'utf8');
    expect(savedRemovalRecords(selected)).toBe(records);
    expect(JSON.parse(workflow_read_xmp(selected)).variantName).toBe('Removed objects');
    expect(await fs.readFile(join(root, 'photo.xmp'))).toEqual(primary);
    expect(new Uint8Array(await fs.readFile(join(root, 'photo.dng')))).toEqual(
      fixture('source.dng'),
    );
    await sidecars.bindVariant('photo', folder, 'photo.dng', 'primary');
    expect(
      savedRemovalRecords(
        TestBed.inject(SavedRemovalRenderService).serialize('photo', defaultAdjustmentModel()),
      ),
    ).toBeUndefined();
  });

  it('reopens verified companions from a read-only folder and refuses publication', async () => {
    const records = await publish();
    const reader = new LocalRemovalAssets(
      TestBed.inject(FolderAccessService),
      { ...folder, write: false },
      'photo.dng',
    );
    const bundle = await reader.readBundle(records);
    expect(JSON.parse(bundle.manifest)).toHaveLength(2);
    await expect(
      reader.publish(text('request.txt'), '[]', fixture('mask.mimf'), fixture('patch.f16')),
    ).rejects.toThrow('write access');
    expect(new Uint8Array(await fs.readFile(join(root, 'photo.dng')))).toEqual(
      fixture('source.dng'),
    );
  });

  it('publishes shared bytes idempotently and confirms XMP without changing the RAW or foreign XML', async () => {
    const records = await publish();
    expect(records).toBe(text('records.txt'));
    expect(await publish()).toBe(records);
    await commit(records);
    expect(TestBed.inject(SidecarSaveStateService).phase()).toBe('saved');
    const xml = await fs.readFile(join(root, 'photo.xmp'), 'utf8');
    expect(xml).toContain('foreign:Keep="untouched"');
    expect(xml).toContain('foreign:History');
    expect(new Uint8Array(await fs.readFile(join(root, 'photo.dng')))).toEqual(
      fixture('source.dng'),
    );
    expect((await assets.read(records)).size).toBe(2);
    const bundle = await assets.readBundle(records);
    expect(bundle.bytes.byteLength).toBe(
      fixture('mask.mimf').byteLength + fixture('patch.f16').byteLength,
    );
    expect(JSON.parse(bundle.manifest)).toHaveLength(2);
    // Ordinary slider writes preserve the newly accepted stack even when their
    // cached passthrough was captured before Keep.
    sidecars.scheduleWrite(
      'photo',
      folder,
      'photo.dng',
      { ...defaultAdjustmentModel(), exposure: 1 },
      culling,
    );
    await sidecars.flushAsset('photo');
    const reopened = TestBed.inject(XmpParserService).parseAdjustmentModel(
      await fs.readFile(join(root, 'photo.xmp'), 'utf8'),
    );
    expect(
      reopened.passthrough.unknownAttributes.find((a) => a.name === 'papp:InpaintRemovals')?.value,
    ).toBe(records);
  });

  it('preserves accepted removals and snapshots when a stale semantic capture is published', async () => {
    const records = await publish();
    await commit(records);
    const accepted = await fs.readFile(join(root, 'photo.xmp'), 'utf8');
    const snapshot = {
      id: crypto.randomUUID(),
      name: 'Accepted removal',
      createdAtMs: Date.now(),
      adjustmentXmp: workflow_checkpoint_xmp(accepted),
    };
    await sidecars.writeWorkflow('photo', folder, 'photo.dng', {
      schemaVersion: 1,
      variantId: 'primary',
      variantName: 'Original',
      snapshots: [snapshot],
      history: [],
    });
    const stale = { ...defaultAdjustmentModel(), exposure: 1 };
    TestBed.inject(HostedWorkflowWriterService).capture(
      folder,
      'photo.xmp',
      stale,
      culling,
      'adjustment',
      'Exposure',
    );
    sidecars.scheduleWrite('photo', folder, 'photo.dng', stale, culling);
    await sidecars.flushAsset('photo');
    const output = await fs.readFile(join(root, 'photo.xmp'), 'utf8');
    const workflow = JSON.parse(workflow_read_xmp(output)) as SidecarWorkflow;
    expect(savedRemovalRecords(output)).toBe(records);
    expect(workflow.snapshots).toEqual([snapshot]);
    expect(workflow.history).toHaveLength(1);
    expect(savedRemovalRecords(workflow.history[0].adjustmentXmp)).toBe(records);
    expect(TestBed.inject(XmpParserService).parseAdjustmentModel(output).model.exposure).toBe(1);
    expect(new Uint8Array(await fs.readFile(join(root, 'photo.dng')))).toEqual(
      fixture('source.dng'),
    );
  });

  it('confirms and reopens the explicit calibration plate without downgrading it', async () => {
    const fixtureRequest: unknown = JSON.parse(text('request.txt'));
    if (
      typeof fixtureRequest !== 'object' ||
      fixtureRequest === null ||
      Array.isArray(fixtureRequest)
    ) {
      throw new Error('Invalid object-removal request fixture');
    }
    const request = JSON.stringify({ ...fixtureRequest, plate: 'linear-calibration-v1' });
    const records = await assets.publish(request, '[]', fixture('mask.mimf'), fixture('patch.f16'));
    expect(JSON.parse(records)).toMatchObject([
      { schema: 4, accepted: { plate: 'linear-calibration-v1' } },
    ]);
    await commit(records);
    const xml = await fs.readFile(join(root, 'photo.xmp'), 'utf8');
    const reopened = TestBed.inject(XmpParserService).parseAdjustmentModel(xml);
    expect(
      reopened.passthrough.unknownAttributes.find((a) => a.name === 'papp:InpaintRemovals')?.value,
    ).toBe(records);
    expect((await assets.read(records)).size).toBe(2);
    expect(new Uint8Array(await fs.readFile(join(root, 'photo.dng')))).toEqual(
      fixture('source.dng'),
    );
    const downgraded = records.replace('"schema":4', '"schema":3');
    await expect(assets.read(downgraded)).rejects.toThrow();
  });

  it('refuses stale XMP and missing companions without replacing the sidecar', async () => {
    const records = await publish();
    const before = await fs.readFile(join(root, 'photo.xmp'));
    await expect(commit(records, 'stale')).rejects.toThrow('photo changed');
    expect(await fs.readFile(join(root, 'photo.xmp'))).toEqual(before);
    const names = await fs.readdir(join(root, '.maple/inpaint'));
    await fs.rm(join(root, '.maple/inpaint', names[0]));
    await expect(commit(records)).rejects.toThrow();
    expect(await fs.readFile(join(root, 'photo.xmp'))).toEqual(before);
    expect(TestBed.inject(SidecarSaveStateService).phase()).toBe('error');
  });

  it('refuses a replaced original at publication and commit', async () => {
    const records = await publish();
    const before = await fs.readFile(join(root, 'photo.xmp'));
    await fs.writeFile(join(root, 'photo.dng'), 'replaced');
    await expect(publish()).rejects.toThrow('original changed');
    await expect(commit(records)).rejects.toThrow('original changed');
    expect(await fs.readFile(join(root, 'photo.xmp'))).toEqual(before);
  });

  it('detects corrupt existing immutable assets and retains prior sidecar bytes', async () => {
    const records = await publish();
    const names = await fs.readdir(join(root, '.maple/inpaint'));
    await fs.writeFile(join(root, '.maple/inpaint', names[0]), 'corrupt');
    await expect(assets.read(records)).rejects.toThrow();
    await expect(publish()).rejects.toThrow();
    expect(await fs.readFile(join(root, 'photo.xmp'))).toEqual(Buffer.from(fixture('prior.xmp')));
  });
});
