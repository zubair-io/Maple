// A reopened editor rebuilds Undo/Redo from the sidecar's retained history (#4983):
// real sidecar files written by the Hosted writer, read back as a fresh editor
// would, through the real Rust workflow module (in-process; jsdom has no Worker).
import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderAccessService } from '../folder-access/folder-access.service';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import {
  fsAccessListEntries,
  fsAccessReadFile,
  fsAccessWriteFile,
} from '../folder-access/fs-access-backend';
import {
  WORKFLOW_HISTORY_LIMIT,
  type SidecarWorkflow,
  type WorkflowHistoryEntry,
} from '../generated/workflow.generated';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { Asset } from '../models/asset';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { initSync, workflow_read_xmp } from '../raw-pipeline/pkg/raw_wasm';
import { LibraryStateService } from '../state/library-state.service';
import { LibraryStore } from '../state/library-store.service';
import { DiskDirectory } from './copy-paste/testing/batch-test-files';
import { EditTransactionRing, UNDO_STACK_CAP } from './edit-transaction-ring';
import { reopenWorkflowRing } from './editor-state.workflow';
import { EditorStateService } from './editor-state.service';
import { makeLibraryStub } from './editor-state.test-helpers';
import { historyRingSteps } from './editor-workflow-ring';
import { inProcessWorkflowXmp } from '../xmp/testing/in-process-workflow-xmp';
import { WorkflowVariantStoreService } from '../xmp/workflow-variant-store.service';
import { WorkflowXmpService } from '../xmp/workflow-xmp.service';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { XmpStoreService } from '../xmp/xmp-store.service';

const authored = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="1" /></rdf:RDF></x:xmpmeta>`;
const culling = { rating: 1, flag: 'unflagged' as const, colorLabel: null, keywords: [] };

describe('reopened editor history ring', () => {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  const core = inProcessWorkflowXmp;
  const parser = new XmpParserService();
  const serializer = new XmpSerializerService();
  let root: string;
  let folder: MapleFolderHandle;
  let store: XmpStoreService;
  const path = () => join(root, 'photo.xmp');
  const onDisk = () => fs.readFile(path(), 'utf8');
  const record = async (xml: string): Promise<SidecarWorkflow> => (await core.read(xml))!;
  const commit = (contrast: number) =>
    store.commitSemantic(
      'asset',
      folder,
      'photo.dng',
      { ...defaultAdjustmentModel(), contrast },
      culling,
      'adjustment',
      `Contrast ${contrast}`,
    );
  const modelOf = (xml: string) => ({
    ...defaultAdjustmentModel(),
    ...parser.parseAdjustmentModel(xml).model,
  });
  const reopened = async () => {
    const xml = await onDisk();
    return historyRingSteps(
      {
        record: await record(xml),
        cursor: await core.cursor(xml),
        current: await core.checkpoint(xml),
      },
      modelOf,
    );
  };
  /** Publish an Undo/Redo replay of `entry`'s state the way a confirmed restore does. */
  async function replay(entry: WorkflowHistoryEntry, action: 'undo' | 'redo'): Promise<void> {
    const xml = await onDisk();
    const parentId = (await record(xml)).history.at(-1)!.id;
    await TestBed.inject(WorkflowVariantStoreService).commit(
      folder,
      'photo.xmp',
      'primary',
      xml,
      entry.adjustmentXmp,
      {
        id: crypto.randomUUID(),
        createdAtMs: Date.now(),
        action,
        label: `${action} ${entry.label}`,
        parentId,
        writer: 'web',
        adjustmentXmp: entry.adjustmentXmp,
      },
    );
  }

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
    root = await fs.mkdtemp(join(tmpdir(), 'maple-ring-'));
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
        { provide: LibraryStateService, useValue: makeLibraryStub() },
        { provide: RawPipelineService, useValue: {} },
        { provide: LiveAnnouncer, useValue: { announce: () => Promise.resolve() } },
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

  it('steps back through every retained state and forward again after an Undo', async () => {
    for (const contrast of [10, 20, 30]) await commit(contrast);
    const entries = (await record(await onDisk())).history;

    const fresh = await reopened();
    expect(fresh.redo).toEqual([]);
    expect(fresh.undo.map((step) => step.description)).toEqual(['Contrast 20', 'Contrast 30']);
    expect(fresh.undo.map((step) => step.checkpoint.before)).toEqual([
      entries[0].adjustmentXmp,
      entries[1].adjustmentXmp,
    ]);
    expect(fresh.undo[1].after.contrast).toBe(30);
    expect(fresh.undo[1].before.contrast).toBe(20);

    await replay(entries[1], 'undo');
    const undone = await reopened();
    expect(undone.undo.map((step) => step.description)).toEqual(['Contrast 20']);
    expect(undone.redo.map((step) => step.description)).toEqual(['Contrast 30']);
    expect(undone.redo[0].checkpoint.after).toBe(entries[2].adjustmentXmp);
    expect(undone.redo[0].before.contrast).toBe(20);

    await replay(entries[2], 'redo');
    const redone = await reopened();
    expect(redone.undo).toHaveLength(2);
    expect(redone.redo).toEqual([]);
  });

  it('seeds the ring so Undo and Redo replay the persisted checkpoints', async () => {
    for (const contrast of [10, 20, 30]) await commit(contrast);
    const entries = (await record(await onDisk())).history;
    await replay(entries[1], 'undo');
    const { undo, redo } = await reopened();

    const ring = new EditTransactionRing();
    expect(ring.seed(serializer, undo, redo)).toBe(true);
    expect(ring.canUndo(null)).toBe(true);
    expect(ring.canRedo()).toBe(true);
    expect(ring.peek('undo')?.checkpoint?.before).toBe(entries[0].adjustmentXmp);
    expect(ring.peek('redo')?.checkpoint?.after).toBe(entries[2].adjustmentXmp);
    expect(ring.peek('undo')?.kind).toBe('variant');
    ring.popUndo();
    expect(ring.peek('redo')?.checkpoint?.before).toBe(entries[0].adjustmentXmp);
  });

  it('never replaces a ring that has already recorded or opened an edit', () => {
    const ring = new EditTransactionRing();
    ring.open('adjustment', 'Exposure', defaultAdjustmentModel());
    expect(ring.seed(serializer, [], [])).toBe(false);
    ring.cancel();
    ring.open('adjustment', 'Exposure', defaultAdjustmentModel());
    ring.close(serializer, { ...defaultAdjustmentModel(), exposure: 1 });
    expect(ring.seed(serializer, [], [])).toBe(false);
  });

  it('makes the retained head an extra Undo step after an outside edit', async () => {
    for (const contrast of [10, 20]) await commit(contrast);
    const entries = (await record(await onDisk())).history;
    await fs.writeFile(path(), (await onDisk()).replace('xmp:Rating="1"', 'xmp:Rating="5"'));

    const { undo, redo } = await reopened();
    expect(redo).toEqual([]);
    expect(undo.map((step) => step.description)).toEqual([
      'Contrast 20',
      'Changes outside the history',
    ]);
    expect(undo[1].checkpoint.before).toBe(entries[1].adjustmentXmp);
  });

  it('keeps Undo up to the history cap after a reload', async () => {
    for (let contrast = 1; contrast <= WORKFLOW_HISTORY_LIMIT + 3; contrast++)
      await commit(contrast);
    expect((await record(await onDisk())).history).toHaveLength(WORKFLOW_HISTORY_LIMIT);

    const { undo, redo } = await reopened();
    expect(undo).toHaveLength(WORKFLOW_HISTORY_LIMIT - 1);
    expect(undo.at(-1)?.description).toBe(`Contrast ${WORKFLOW_HISTORY_LIMIT + 3}`);
    const ring = new EditTransactionRing();
    ring.seed(serializer, undo, redo);
    expect(ring.history()).toHaveLength(WORKFLOW_HISTORY_LIMIT - 1);
    expect(WORKFLOW_HISTORY_LIMIT - 1).toBeLessThanOrEqual(UNDO_STACK_CAP);
  });

  describe('opening an asset', () => {
    const open = async (replaceBinding: boolean) => {
      const ring = new EditTransactionRing();
      let generation = 1;
      const editor = {
        get bindingGeneration() {
          return generation;
        },
        ring,
        serializer,
        workflowError: signal<string | null>(null),
        currentAdjustment: () => defaultAdjustmentModel(),
        workflowCommands: {
          capture: () => ({ id: 'asset' }),
          ringSteps: async () => {
            const steps = await reopened();
            if (replaceBinding) generation += 1;
            return steps;
          },
          history: { isCurrent: () => true },
        },
      } as unknown as EditorStateService;
      await reopenWorkflowRing(editor, { id: 'asset', generation: 1 });
      return ring;
    };

    it('rebuilds the ring for the bound asset', async () => {
      for (const contrast of [10, 20, 30]) await commit(contrast);
      const ring = await open(false);
      expect(ring.history().map((tx) => tx.description)).toEqual(['Contrast 20', 'Contrast 30']);
    });

    it('drops a rebuild whose binding was replaced while the sidecar was read', async () => {
      for (const contrast of [10, 20, 30]) await commit(contrast);
      expect((await open(true)).history()).toEqual([]);
    });

    it('rebuilds the ring once a cold open resolves the bound asset (#5388)', async () => {
      for (const contrast of [10, 20, 30]) await commit(contrast);
      const library = TestBed.inject(LibraryStore);
      const editor = TestBed.inject(EditorStateService);
      // A reload or deep link binds before the library knows the asset and its folder.
      editor.bind('asset');
      TestBed.tick();
      library.currentFolder.set(folder);
      library.assets.set([{ id: 'asset', filename: 'photo.dng' } as Asset]);
      TestBed.tick();
      await vi.waitFor(() =>
        expect(editor.undoHistory().map((tx) => tx.description)).toEqual([
          'Contrast 20',
          'Contrast 30',
        ]),
      );
      expect(editor.canUndo()).toBe(true);
    });
  });
});
