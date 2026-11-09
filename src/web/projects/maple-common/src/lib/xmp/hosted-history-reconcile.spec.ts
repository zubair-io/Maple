// A stale Hosted save merges onto the sidecar instead of being refused, records the
// divergence, and keeps both writers' entries (#4983). Real sidecar text and the
// real Rust workflow module, run in-process because jsdom has no Worker.
import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FolderAccessService } from '../folder-access/folder-access.service';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import {
  fsAccessListEntries,
  fsAccessReadFile,
  fsAccessWriteFile,
} from '../folder-access/fs-access-backend';
import { DiskDirectory } from '../editor/copy-paste/testing/batch-test-files';
import type { WorkflowHistoryEntry } from '../generated/workflow.generated';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import { initSync, workflow_checkpoint_xmp, workflow_read_xmp } from '../raw-pipeline/pkg/raw_wasm';
import { HostedSidecarFreshnessService } from './hosted-sidecar-freshness.service';
import { HostedWorkflowWriterService } from './hosted-workflow-writer.service';
import { inProcessWorkflowXmp } from './testing/in-process-workflow-xmp';
import { WorkflowXmpService } from './workflow-xmp.service';
import { XmpParserService } from './xmp-parser.service';
import type { MergedSidecar } from './sidecar-binding';
import { XmpStoreService } from './xmp-store.service';

const FOREIGN_ATTRIBUTE = 'acme:Keep="ünknown &amp; kept"';
const FOREIGN_ITEM = '<acme:Item>a &lt; b</acme:Item>';
const FOREIGN_CHILD = `<acme:Block acme:id="7">${FOREIGN_ITEM}</acme:Block>`;
const authored = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:acme="http://acme.example/1.0/" xmp:Rating="1" ${FOREIGN_ATTRIBUTE}>${FOREIGN_CHILD}</rdf:Description></rdf:RDF></x:xmpmeta>`;
const culling = (rating: number) => ({
  rating,
  flag: 'unflagged' as const,
  colorLabel: null,
  keywords: [],
});
const history = (xml: string): WorkflowHistoryEntry[] => JSON.parse(workflow_read_xmp(xml)).history;

describe('Hosted history reconciliation', () => {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  const parser = new XmpParserService();
  let root: string;
  let folder: MapleFolderHandle;
  let store: XmpStoreService;
  const path = () => join(root, 'photo.xmp');
  const onDisk = () => fs.readFile(path(), 'utf8');
  const commit = (contrast: number, rating = 1, extra: object = {}) =>
    store.commitSemantic(
      'asset',
      folder,
      'photo.dng',
      { ...defaultAdjustmentModel(), contrast, ...extra },
      culling(rating),
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
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'maple-hosted-history-'));
    await fs.writeFile(join(root, 'photo.dng'), new Uint8Array([0x49, 0x49, 0x2a, 0x00]));
    await fs.writeFile(path(), authored);
    folder = {
      name: 'photos',
      read: true,
      write: true,
      native: new DiskDirectory(root) as unknown as FileSystemDirectoryHandle,
    };
    TestBed.configureTestingModule({
      providers: [
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
    store = TestBed.inject(XmpStoreService);
    store.replaceLoadedDocuments(folder, new Map([['photo.xmp', authored]]));
  });
  afterEach(async () => {
    store.cancelPending();
    await fs.rm(root, { recursive: true, force: true });
  });
  afterAll(() => {
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else Reflect.deleteProperty(navigator, 'locks');
  });

  it('records both writers and the outside edit, keeping unknown content', async () => {
    const merges: MergedSidecar[] = [];
    store.merged.subscribe((merge) => merges.push(merge));
    await commit(10);
    const first = await onDisk();
    const [initial] = history(first);
    expect(initial).toMatchObject({ action: 'adjustment', writer: 'web', parentId: '' });

    // An outside tool rates the photo 4 and leaves Maple's record alone.
    const outside = first.replace('xmp:Rating="1"', 'xmp:Rating="4"');
    expect(outside).not.toBe(first);
    await fs.writeFile(path(), outside);
    await commit(20);

    const final = await onDisk();
    const entries = history(final);
    expect(entries.map((entry) => entry.action)).toEqual(['adjustment', 'external', 'adjustment']);
    expect(entries[1]).toMatchObject({ parentId: initial.id, writer: '' });
    expect(entries[1].adjustmentXmp).toBe(workflow_checkpoint_xmp(outside));
    expect(entries[2]).toMatchObject({ writer: 'web', parentId: initial.id, label: 'Contrast 20' });
    expect(entries[2].adjustmentXmp).toBe(workflow_checkpoint_xmp(final));

    const merged = parser.parseAdjustmentModel(final).model;
    expect(merged.contrast).toBe(20);
    expect(parser.parseCulling(final).rating).toBe(4);
    expect(final).toContain(FOREIGN_ATTRIBUTE);
    expect(final).toContain(FOREIGN_ITEM);
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ assetId: 'asset', xml: final, pending: false });
    expect(merges[0].saved.model.contrast).toBe(20);
  });

  it('keeps an outside edit to a property the save did not change', async () => {
    await commit(10);
    const first = await onDisk();
    const outside = first.replace('xmp:Rating="1"', 'xmp:Rating="5"');
    await fs.writeFile(path(), outside);
    store.scheduleWrite('asset', folder, 'photo.dng', defaultAdjustmentModel(), {
      ...parser.parseCulling(first),
      keywords: ['kept'],
    });
    await store.flushAll();
    const final = await onDisk();
    expect(parser.parseCulling(final)).toMatchObject({ rating: 5, keywords: ['kept'] });
    expect(history(final).map((entry) => entry.action)).toEqual(['adjustment', 'external']);
  });

  it('keeps both writers entries when two writers save from one base', async () => {
    await commit(10);
    const base = await onDisk();
    const [initial] = history(base);
    const other = createEnvironmentInjector(
      [HostedWorkflowWriterService, HostedSidecarFreshnessService],
      TestBed.inject(EnvironmentInjector),
    );
    other.get(HostedSidecarFreshnessService).replaceFolder(folder, new Map([['photo.xmp', base]]));
    const writer = other.get(HostedWorkflowWriterService);
    const model = { ...defaultAdjustmentModel(), contrast: 10, highlights: -20 };
    writer.capture(folder, 'photo.xmp', model, culling(1), 'adjustment', 'Highlights');
    await writer.write(folder, 'photo.xmp', model, culling(1));

    await commit(20);

    const final = await onDisk();
    const entries = history(final);
    expect(entries.map((entry) => entry.label)).toEqual([
      'Contrast 10',
      'Highlights',
      'Contrast 20',
    ]);
    expect(entries.map((entry) => entry.action)).not.toContain('external');
    expect(entries.slice(1).map((entry) => entry.parentId)).toEqual([initial.id, initial.id]);
    expect(entries.every((entry) => entry.writer === 'web')).toBe(true);
    expect(parser.parseAdjustmentModel(final).model).toMatchObject({
      contrast: 20,
      highlights: -20,
    });
    expect(final).toContain(FOREIGN_ITEM);
  });

  it('appends several captured actions after a merge, each naming its parent', async () => {
    await commit(10);
    const first = await onDisk();
    const [initial] = history(first);
    await fs.writeFile(path(), first.replace('xmp:Rating="1"', 'xmp:Rating="3"'));
    const writer = TestBed.inject(HostedWorkflowWriterService);
    const model = { ...defaultAdjustmentModel(), contrast: 30 };
    writer.capture(folder, 'photo.xmp', model, culling(1), 'adjustment', 'First');
    writer.capture(
      folder,
      'photo.xmp',
      { ...model, contrast: 40 },
      culling(1),
      'adjustment',
      'Second',
    );
    const { xml, reconciled } = await writer.write(
      folder,
      'photo.xmp',
      { ...model, contrast: 40 },
      culling(1),
    );
    const entries = history(xml);
    expect(reconciled).toBe(true);
    expect(entries.map((entry) => entry.label)).toEqual([
      'Contrast 10',
      'Changed outside Maple',
      'First',
      'Second',
    ]);
    expect(entries[2].parentId).toBe(initial.id);
    expect(entries[3].parentId).toBe(entries[2].id);
    expect(entries[3].adjustmentXmp).toBe(workflow_checkpoint_xmp(xml));
    expect(parser.parseCulling(xml).rating).toBe(3);
  });
});
