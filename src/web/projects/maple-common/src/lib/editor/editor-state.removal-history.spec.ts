import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as workerThreads from 'node:worker_threads';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { initSync } from '../raw-pipeline/pkg/raw_wasm';
import { DiskDirectory } from './copy-paste/testing/batch-test-files';
import { fsAccessReadFile, fsAccessWriteFile } from '../folder-access/fs-access-backend';
import { FolderAccessService } from '../folder-access/folder-access.service';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { LibraryStateService } from '../state/library-state.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';
import type { Asset } from '../models/asset';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { LocalRemovalAssets } from '../removal/local-removal-assets';
import { savedRemovalRecords } from '../removal/saved-removal-records';
import { EditorStateService } from './editor-state.service';

const fixtures = resolve(process.cwd(), '../../test-fixtures/removal/calibration');
const bytes = (name: string) => new Uint8Array(readFileSync(join(fixtures, name)));
const text = (name: string) => new TextDecoder().decode(bytes(name));

// The sidecar writer, locks, RAW, companions and files are real. Only the
// library presentation signal is adapted to avoid bootstrapping a whole shell.
describe('confirmed Web removal history with real XMP and companions', () => {
  let root: string,
    folder: MapleFolderHandle,
    editor: EditorStateService,
    sidecars: XmpStoreService;
  let records: string, revision: string;
  let failWrite: boolean, held: Promise<void> | undefined, entered: boolean;
  let library: {
    assets: ReturnType<typeof signal<Asset[]>>;
    focusedAsset: ReturnType<typeof signal<Asset>>;
    removalSavingAsset: ReturnType<typeof signal<string | null>>;
    adjustmentFor: (id: string) => ReturnType<typeof signal<AdjustmentModel>>;
    updateAdjustment: (id: string, patch: Partial<AdjustmentModel>) => void;
    adoptConfirmedRemoval: (id: string, target: AdjustmentModel) => void;
  };
  beforeAll(() => {
    initSync({
      module: readFileSync(
        resolve(process.cwd(), 'projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm_bg.wasm'),
      ),
    });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: Reflect.get(workerThreads, 'locks'),
    });
  });
  beforeEach(async () => {
    failWrite = false;
    held = undefined;
    entered = false;
    root = await fs.mkdtemp(join(tmpdir(), 'maple-removal-history-'));
    await fs.writeFile(join(root, 'photo.dng'), bytes('source.dng'));
    await fs.writeFile(join(root, 'photo.xmp'), bytes('prior.xmp'));
    folder = {
      name: root,
      read: true,
      write: true,
      native: new DiskDirectory(root) as unknown as FileSystemDirectoryHandle,
    };
    const asset = {
      id: 'photo',
      filename: 'photo.dng',
      rating: 0,
      flag: 'unflagged',
      colorLabel: null,
    } as Asset;
    const models = new Map<string, ReturnType<typeof signal<AdjustmentModel>>>();
    const modelFor = (id: string) => {
      const old = models.get(id);
      if (old) return old;
      const model = signal(defaultAdjustmentModel());
      models.set(id, model);
      return model;
    };
    library = {
      assets: signal([asset]),
      focusedAsset: signal(asset),
      removalSavingAsset: signal<string | null>(null),
      adjustmentFor: modelFor,
      updateAdjustment: (id, patch) => {
        if (library.removalSavingAsset() === id) return;
        modelFor(id).update((current) => ({ ...current, ...patch }));
        sidecars.scheduleWrite(id, folder, 'photo.dng', modelFor(id)(), asset);
      },
      adoptConfirmedRemoval: (id, target) => modelFor(id).set(target),
    };
    TestBed.configureTestingModule({
      providers: [
        {
          provide: LibraryStateService,
          useValue: { ...library, currentFolder: () => folder, asShotWbFor: () => undefined },
        },
        { provide: RawPipelineService, useValue: {} },
        {
          provide: FolderAccessService,
          useValue: {
            readFile: fsAccessReadFile,
            writeFile: async (scope: MapleFolderHandle, name: string, value: Uint8Array) => {
              if (name.endsWith('.xmp')) {
                entered = true;
                if (held) await held;
                if (failWrite) throw new DOMException('Write access revoked', 'NotAllowedError');
              }
              await fsAccessWriteFile(scope, name, value);
            },
          },
        },
      ],
    });
    sidecars = TestBed.inject(XmpStoreService);
    sidecars.rememberPassthrough(
      'photo',
      TestBed.inject(XmpParserService).parseAdjustmentModel(text('prior.xmp')).passthrough,
    );
    editor = TestBed.inject(EditorStateService);
    editor.bind('photo');
    const assets = new LocalRemovalAssets(TestBed.inject(FolderAccessService), folder, 'photo.dng');
    records = await assets.publish(
      text('request.txt'),
      '[]',
      bytes('mask.mimf'),
      bytes('patch.f16'),
    );
    revision = await sidecars.captureRemovalRevision('photo', folder, 'photo.dng');
  });
  afterEach(async () => {
    await sidecars.flushAll();
    await fs.rm(root, { recursive: true, force: true });
  });
  const accept = () =>
    editor.acceptRemoval(records, editor.currentAdjustment()!, 'Remove object', revision);
  const undo = async () => {
    editor.undo();
    await editor.settleRemovalSave();
  };
  const redo = async () => {
    editor.redo();
    await editor.settleRemovalSave();
  };
  const saved = async () => savedRemovalRecords(await fs.readFile(join(root, 'photo.xmp'), 'utf8'));
  const slider = (exposure: number) => {
    editor.commit('adjustment', 'Exposure');
    library.updateAdjustment('photo', { exposure });
    editor.endEdit();
  };

  it('adopts pixels and records exactly one transaction only after real persistence', async () => {
    let release!: () => void;
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = accept();
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(editor.currentAdjustment()!.inpaintRemovals).toBeUndefined();
    expect(editor.undoHistory()).toHaveLength(0);
    expect(editor.canUndo()).toBe(false);
    library.updateAdjustment('photo', { exposure: 3 });
    expect(editor.currentAdjustment()!.exposure).toBe(0);
    release();
    await task;
    expect(editor.undoHistory()).toHaveLength(1);
    expect(editor.undoHistory()[0].diff).toContainEqual({
      key: 'papp:InpaintRemovals',
      before: null,
      after: records,
    });
    expect(editor.undoHistory()[0].invalidation).toBe('decode');
    expect(await saved()).toBe(records);
    expect(editor.currentAdjustment()!.inpaintRemovals).toBe(records);
    expect(await fs.readFile(join(root, 'photo.dng'))).toEqual(Buffer.from(bytes('source.dng')));
  });

  it('interleaves scalar and removal edits through the normal undo/redo ring', async () => {
    slider(0.5);
    revision = await sidecars.captureRemovalRevision('photo', folder, 'photo.dng');
    await accept();
    slider(1);
    await sidecars.flushAsset('photo');
    editor.undo();
    await sidecars.flushAsset('photo');
    expect(editor.currentAdjustment()!.exposure).toBe(0.5);
    expect(await saved()).toBe(records);
    await undo();
    expect(await saved()).toBeUndefined();
    expect(editor.currentAdjustment()!.exposure).toBe(0.5);
    editor.undo();
    await sidecars.flushAsset('photo');
    expect(editor.currentAdjustment()!.exposure).toBe(0);
    editor.redo();
    await sidecars.flushAsset('photo');
    await redo();
    expect(await saved()).toBe(records);
    expect(editor.currentAdjustment()!.exposure).toBe(0.5);
    editor.redo();
    await sidecars.flushAsset('photo');
    expect(editor.currentAdjustment()!.exposure).toBe(1);
    expect(editor.undoHistory()).toHaveLength(3);
    expect(await fs.readdir(join(root, '.maple/inpaint'))).toHaveLength(2);
  });

  it('failed undo retains the current model and both history stacks for retry', async () => {
    await accept();
    const before = await fs.readFile(join(root, 'photo.xmp'));
    failWrite = true;
    await expect(undo()).rejects.toThrow('Write access revoked');
    expect(editor.currentAdjustment()!.inpaintRemovals).toBe(records);
    expect(editor.undoHistory()).toHaveLength(1);
    expect(editor.canRedo()).toBe(false);
    expect(await fs.readFile(join(root, 'photo.xmp'))).toEqual(before);
    expect(editor.removalSaveError()).toContain('Write access revoked');
    failWrite = false;
    await undo();
    expect(await saved()).toBeUndefined();
    await redo();
    expect(await saved()).toBe(records);
  });

  it('redo refuses a missing asset and keeps its history entry until restored', async () => {
    await accept();
    await undo();
    const name = (await fs.readdir(join(root, '.maple/inpaint'))).find((name) =>
      name.endsWith('.f16'),
    )!;
    const path = join(root, '.maple/inpaint', name);
    const backup = await fs.readFile(path);
    await fs.rm(path);
    await expect(redo()).rejects.toThrow();
    expect(editor.currentAdjustment()!.inpaintRemovals).toBeUndefined();
    expect(editor.canRedo()).toBe(true);
    expect(await saved()).toBeUndefined();
    await fs.writeFile(path, backup);
    await redo();
    expect(await saved()).toBe(records);
  });

  it('full-XMP conflict cannot overwrite another application’s scalar or foreign edits', async () => {
    const changed = text('prior.xmp').replace('untouched', 'external edit');
    await fs.writeFile(join(root, 'photo.xmp'), changed);
    await expect(accept()).rejects.toThrow('changed');
    await expect(accept()).rejects.toThrow('changed');
    expect(await fs.readFile(join(root, 'photo.xmp'), 'utf8')).toBe(changed);
    expect(editor.undoHistory()).toHaveLength(0);
    expect(editor.currentAdjustment()!.inpaintRemovals).toBeUndefined();
  });

  it('undo clearing the last removal still verifies the original identity', async () => {
    await accept();
    await fs.writeFile(join(root, 'photo.dng'), 'external replacement');
    await expect(undo()).rejects.toThrow();
    expect(await saved()).toBe(records);
    expect(editor.undoHistory()).toHaveLength(1);
  });

  it('navigation during a save commits only the captured photo and never its new ring', async () => {
    let release!: () => void;
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = accept();
    await vi.waitFor(() => expect(entered).toBe(true));
    const other = { ...library.focusedAsset(), id: 'other', filename: 'other.dng' };
    library.assets.set([...library.assets(), other]);
    library.focusedAsset.set(other);
    editor.bind('other');
    release();
    await task;
    expect(await saved()).toBe(records);
    expect(library.adjustmentFor('photo')().inpaintRemovals).toBe(records);
    expect(editor.currentAdjustment()!.inpaintRemovals).toBeUndefined();
    expect(editor.undoHistory()).toHaveLength(0);
  });

  it('whole-model reset confirms removal clearing and remains undoable with retained assets', async () => {
    await accept();
    slider(1);
    await sidecars.flushAsset('photo');
    expect(editor.resetAll()).toBe(true);
    await editor.settleRemovalSave();
    expect(await saved()).toBeUndefined();
    expect(editor.currentAdjustment()!.profile).toBe('Auto');
    expect(editor.undoHistory().at(-1)?.kind).toBe('reset');
    await undo();
    expect(await saved()).toBe(records);
    expect(editor.currentAdjustment()!.exposure).toBe(1);
    expect(await fs.readdir(join(root, '.maple/inpaint'))).toHaveLength(2);
  });
});
