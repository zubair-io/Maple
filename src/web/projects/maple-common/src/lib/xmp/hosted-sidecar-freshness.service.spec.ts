import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { FolderAccessService } from '../folder-access/folder-access.service';
import {
  fsAccessListEntries,
  fsAccessReadFile,
  fsAccessWriteFile,
} from '../folder-access/fs-access-backend';
import { DiskDirectory } from '../editor/copy-paste/testing/batch-test-files';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import {
  initSync,
  workflow_checkpoint_xmp,
  workflow_commit_xmp,
  workflow_embed_xmp,
  workflow_read_xmp,
  workflow_snapshot_xmp,
  workflow_variant_filename,
} from '../raw-pipeline/pkg/raw_wasm';
import {
  parseSidecarWorkflow,
  type WorkflowHistoryEntry,
  type SidecarWorkflow,
  type WorkflowSnapshot,
} from '../generated/workflow.generated';
import { SidecarSaveStateService } from './sidecar-save-state.service';
import { HostedWorkflowWriterService } from './hosted-workflow-writer.service';
import { WorkflowVariantStoreService } from './workflow-variant-store.service';
import { WorkflowXmpService } from './workflow-xmp.service';
import { XmpStoreService } from './xmp-store.service';

const sidecar = (rating: number) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="${rating}" /></rdf:RDF></x:xmpmeta>`;
const culling = (rating: number) => ({
  rating,
  flag: 'unflagged' as const,
  colorLabel: null,
  keywords: [],
});

/** The real Rust workflow converter, in-process because jsdom has no Worker. */
class InProcessWorkflowXmp {
  async read(xmp: string): Promise<SidecarWorkflow | null> {
    const value: unknown = JSON.parse(workflow_read_xmp(xmp));
    return value === null ? null : parseSidecarWorkflow(value);
  }
  async variantFilename(primaryName: string, variantId: string): Promise<string> {
    return workflow_variant_filename(primaryName, variantId);
  }
  async checkpoint(xmp: string): Promise<string> {
    return workflow_checkpoint_xmp(xmp);
  }
  async embed(workflow: SidecarWorkflow, xmp: string): Promise<string> {
    return workflow_embed_xmp(JSON.stringify(parseSidecarWorkflow(workflow)), xmp);
  }
  async snapshot(snapshot: WorkflowSnapshot, xmp: string): Promise<string> {
    return workflow_snapshot_xmp(xmp, JSON.stringify(snapshot));
  }
  async commit(entry: WorkflowHistoryEntry, xmp: string): Promise<string> {
    return workflow_commit_xmp(xmp, JSON.stringify(entry));
  }
}

describe('Hosted sidecar external-change protection', () => {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  const raw = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0xde, 0xad, 0xbe, 0xef]);
  let root: string;
  let folder: MapleFolderHandle;
  let store: XmpStoreService;
  let writeFile: ReturnType<typeof vi.fn<typeof fsAccessWriteFile>>;
  let caseFold: boolean;
  const path = () => join(root, 'photo.xmp');
  const physicalName = (name: string) => (caseFold && name === 'photo.xmp' ? 'photo.XMP' : name);

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
  beforeEach(async () => {
    caseFold = false;
    root = await fs.mkdtemp(join(tmpdir(), 'maple-hosted-conflict-'));
    await fs.writeFile(join(root, 'photo.dng'), raw);
    await fs.writeFile(path(), sidecar(0));
    folder = {
      name: 'photos',
      read: true,
      write: true,
      native: new DiskDirectory(root) as unknown as FileSystemDirectoryHandle,
    };
    writeFile = vi.fn((target: MapleFolderHandle, name: string, bytes: Uint8Array) =>
      fsAccessWriteFile(target, physicalName(name), bytes),
    );
    TestBed.configureTestingModule({
      providers: [
        { provide: WorkflowXmpService, useClass: InProcessWorkflowXmp },
        {
          provide: FolderAccessService,
          useValue: {
            listEntries: fsAccessListEntries,
            readFile: (target: MapleFolderHandle, name: string) =>
              fsAccessReadFile(target, physicalName(name)),
            writeFile,
          },
        },
      ],
    });
    store = TestBed.inject(XmpStoreService);
    store.replaceLoadedDocuments(
      folder,
      new Map([['photo.xmp', await fs.readFile(path(), 'utf8')]]),
    );
  });
  afterEach(async () => {
    store.cancelPending();
    await fs.rm(root, { recursive: true, force: true });
  });
  afterAll(() => {
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else Reflect.deleteProperty(navigator, 'locks');
  });

  it('preserves an external edit, reports an unsaved conflict, then saves after reload', async () => {
    const external = sidecar(4);
    await fs.writeFile(path(), external);
    store.scheduleWrite('asset', folder, 'photo.dng', defaultAdjustmentModel(), culling(2));
    await expect(store.flushAll()).rejects.toThrow('changed outside Maple');
    expect(await fs.readFile(path(), 'utf8')).toBe(external);
    expect(writeFile).not.toHaveBeenCalled();
    expect(TestBed.inject(SidecarSaveStateService).phase()).toBe('error');
    store.replaceLoadedDocuments(folder, new Map([['photo.xmp', external]]));
    store.scheduleWrite('asset', folder, 'photo.dng', defaultAdjustmentModel(), culling(3));
    await store.flushAll();
    expect(await fs.readFile(path(), 'utf8')).toContain('xmp:Rating="3"');
    expect(TestBed.inject(SidecarSaveStateService).phase()).toBe('saved');
    expect(new Uint8Array(await fs.readFile(join(root, 'photo.dng')))).toEqual(raw);
  });

  it('accepts an edit after Maple publishes a workflow snapshot', async () => {
    const variants = TestBed.inject(WorkflowVariantStoreService);
    const baseline = await fs.readFile(path(), 'utf8');
    const snapshot: WorkflowSnapshot = {
      id: crypto.randomUUID(),
      name: 'Before rating',
      createdAtMs: Date.now(),
      adjustmentXmp: workflow_checkpoint_xmp(baseline),
    };
    const published = await variants.saveSnapshot(
      folder,
      'photo.xmp',
      'primary',
      baseline,
      snapshot,
    );
    expect(await fs.readFile(path(), 'utf8')).toBe(published);
    expect(JSON.parse(workflow_read_xmp(published)).snapshots).toHaveLength(1);
    store.scheduleWrite('asset', folder, 'photo.dng', defaultAdjustmentModel(), culling(2));
    await store.flushAll();
    const final = await fs.readFile(path(), 'utf8');
    expect(final).toContain('xmp:Rating="2"');
    expect(JSON.parse(workflow_read_xmp(final)).snapshots).toHaveLength(1);
    expect(new Uint8Array(await fs.readFile(join(root, 'photo.dng')))).toEqual(raw);
  });

  it('discards a rejected history capture before saving after reload', async () => {
    TestBed.inject(HostedWorkflowWriterService).capture(
      folder,
      'photo.xmp',
      defaultAdjustmentModel(),
      culling(2),
      'slider',
      'Rejected edit',
    );
    const external = sidecar(4);
    await fs.writeFile(path(), external);
    store.scheduleWrite('asset', folder, 'photo.dng', defaultAdjustmentModel(), culling(2));
    await expect(store.flushAll()).rejects.toThrow('changed outside Maple');
    store.replaceLoadedDocuments(folder, new Map([['photo.xmp', external]]));
    store.scheduleWrite('asset', folder, 'photo.dng', defaultAdjustmentModel(), culling(3));
    await store.flushAll();
    const final = await fs.readFile(path(), 'utf8');
    expect(final).toContain('xmp:Rating="3"');
    expect(JSON.parse(workflow_read_xmp(final))).toBeNull();
  });

  it('saves a sidecar whose physical filename differs only by case', async () => {
    await fs.rename(path(), join(root, 'photo.XMP'));
    caseFold = true;
    store.scheduleWrite('asset', folder, 'photo.dng', defaultAdjustmentModel(), culling(2));
    await store.flushAll();
    expect(await fs.readFile(join(root, 'photo.XMP'), 'utf8')).toContain('xmp:Rating="2"');
  });
});
