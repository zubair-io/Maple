import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as workerThreads from 'node:worker_threads';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  initSync,
  NativeDetailSession,
  RemovalGeneration,
  removal_content_digest,
} from '../raw-pipeline/pkg/raw_wasm';
import { NativeDetailWorker } from '../raw-pipeline/raw-pipeline.native-detail-handler';
import { runRemovalAuthoring } from '../raw-pipeline/raw-pipeline.removal-handler';
import type {
  RemovalAuthoringCommand,
  RemovalRawSession,
} from '../raw-pipeline/raw-pipeline.removal.types';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { LibraryStateService } from '../state/library-state.service';
import { EditorStateService } from '../editor/editor-state.service';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { fsAccessReadFile, fsAccessWriteFile } from '../folder-access/fs-access-backend';
import { DiskDirectory } from '../editor/copy-paste/testing/batch-test-files';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { Asset } from '../models/asset';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { savedRemovalRecords } from './saved-removal-records';
import { RemovalModelStore } from './removal-model-store.service';
import { RemovalEditorSession } from './removal-editor-session.service';
import type { RemovalInferenceClient } from './removal-inference-client';
import type { RemovalProposal } from './removal-inference.types';

const fixtureRoot = resolve(process.cwd(), '../../test-fixtures/removal/basic');
const raw = new Uint8Array(readFileSync(join(fixtureRoot, 'source.dng')));
const prior = readFileSync(join(fixtureRoot, 'prior.xmp'), 'utf8');

// Lifecycle/storage qualification uses an explicit identity-model fixture.
// Actual ONNX execution/photo quality are separate browser/model gates.
function identityProposal(
  request: string,
  records: string,
  scene: Float32Array,
  intent: Uint8Array,
  protectedMask: Uint8Array,
) {
  const model = removal_content_digest(new TextEncoder().encode('test identity model fixture'));
  const generation = new RemovalGeneration(
    JSON.stringify({ ...JSON.parse(request), model, model_version: 'test identity fixture' }),
    records,
    scene,
    intent,
    protectedMask,
  );
  try {
    return {
      request: generation.request(),
      mask: intent,
      patch: generation.finish(generation.rgb()),
    };
  } finally {
    generation.free();
  }
}

describe('editor removal lifecycle with actual retained RAW and filesystem XMP', () => {
  let root: string,
    folder: MapleFolderHandle,
    worker: NativeDetailWorker,
    session: RemovalEditorSession;
  let sidecars: XmpStoreService;
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
    root = await fs.mkdtemp(join(tmpdir(), 'maple-removal-editor-'));
    await fs.writeFile(join(root, 'photo.dng'), raw);
    await fs.writeFile(join(root, 'photo.xmp'), prior);
    folder = {
      name: root,
      read: true,
      write: true,
      native: new DiskDirectory(root) as unknown as FileSystemDirectoryHandle,
    };
    const asset = signal({
      id: 'photo',
      filename: 'photo.dng',
      rating: 3,
      flag: 'pick',
      colorLabel: null,
    } as Asset);
    const model = signal(defaultAdjustmentModel());
    let original: string | undefined;
    const call = (command: RemovalAuthoringCommand) =>
      worker.withRemovalSession(
        'photo',
        'dng',
        command.kind === 'source' ? command.bytes : undefined,
        (retained) =>
          runRemovalAuthoring(retained as unknown as RemovalRawSession, {
            id: 1,
            type: 'removal-authoring',
            sourceId: 'photo',
            ext: 'dng',
            original,
            command,
          }),
      );
    worker = new NativeDetailWorker({
      ready: async () => undefined,
      post: () => undefined,
      open: (bytes, ext) => new NativeDetailSession(bytes, ext),
    });
    const removal = {
      close: () => undefined,
      open: async (input: { bytes: Uint8Array }) => {
        const value = await call({ kind: 'source', bytes: input.bytes.slice().buffer });
        if (value.kind !== 'source') throw Error('Invalid source');
        original = JSON.parse(value.source).original;
        return value.source;
      },
      map: async (xmp: string, request: string) => {
        const value = await call({ kind: 'map', xmp, request });
        if (value.kind !== 'map') throw Error('Invalid map');
        return value.mapping;
      },
      selection: async (request: string) => {
        const value = await call({ kind: 'selection', request });
        if (value.kind !== 'selection') throw Error('Invalid selection');
        return new Uint8Array(value.mask);
      },
      prepareSaved: async (xmp: string, bundle: { manifest: string; bytes: Uint8Array }) => {
        const value = await call({
          kind: 'prepare-saved',
          xmp,
          manifest: bundle.manifest,
          companions: bundle.bytes.slice().buffer,
        });
        if (value.kind !== 'prepared') throw Error('Invalid preparation');
        return value.review;
      },
      generationContext: async (
        xmp: string,
        rect: readonly [number, number, number, number],
        bundle: { manifest: string; bytes: Uint8Array },
      ) => {
        const value = await call({
          kind: 'generation-context',
          xmp,
          rect,
          manifest: bundle.manifest,
          companions: bundle.bytes.slice().buffer,
        });
        if (value.kind !== 'context') throw Error('Invalid context');
        return new Float32Array(value.rgb);
      },
      renderSaved: async (xmp: string, cap: number) => {
        const value = await call({ kind: 'render-saved', xmp, cap });
        if (value.kind !== 'rendered') throw Error('Invalid preview');
        return { ...value.frame, rgb: new Uint8Array(value.frame.rgb) };
      },
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: EditorStateService, useValue: { armedTool: signal('remove') } },
        {
          provide: LibraryStateService,
          useValue: {
            focusedAsset: asset,
            currentFolder: () => folder,
            adjustmentFor: () => model,
          },
        },
        {
          provide: FolderAccessService,
          useValue: { readFile: fsAccessReadFile, writeFile: fsAccessWriteFile },
        },
        { provide: RawPipelineService, useValue: { removal } },
        {
          provide: RemovalModelStore,
          useValue: { installed: async () => new Map(), models: signal(new Map()) },
        },
      ],
    });
    sidecars = TestBed.inject(XmpStoreService);
    sidecars.rememberPassthrough(
      'photo',
      TestBed.inject(XmpParserService).parseAdjustmentModel(prior).passthrough,
    );
    session = TestBed.inject(RemovalEditorSession);
    TestBed.tick();
    await vi.waitFor(() => expect(session.phase()).toBe('ready'));
    session.inference = {
      cancel: () => undefined,
      dispose: () => undefined,
      propose: async (...args: Parameters<typeof identityProposal>) => identityProposal(...args),
    } as unknown as RemovalInferenceClient;
  });
  afterEach(async () => {
    worker.close();
    TestBed.resetTestingModule();
    await fs.rm(root, { recursive: true, force: true });
  });
  const paint = () => session.paint([[3.5 / 16, 2.5 / 8]], [16, 8]);

  it('selects, inspects, keeps and undoes a verified edit while preserving the original and unknown XML', async () => {
    await paint();
    expect(session.selection().length).toBeGreaterThan(0);
    await session.remove();
    expect(session.phase()).toBe('review');
    expect(session.preview()?.rgb.length).toBe(16 * 8 * 3);
    expect(await fs.readFile(join(root, 'photo.xmp'), 'utf8')).toBe(prior);
    await session.keep();
    TestBed.tick();
    expect(session.phase()).toBe('ready');
    expect(session.message()).toBe('Removal saved.');
    const kept = await fs.readFile(join(root, 'photo.xmp'), 'utf8');
    expect(JSON.parse(savedRemovalRecords(kept)!)).toHaveLength(1);
    expect(kept).toContain('foreign:Keep="untouched"');
    expect(kept).toContain(
      TestBed.inject(XmpParserService).parseAdjustmentModel(prior).passthrough.unknownNodes[0],
    );
    expect((await fs.readdir(join(root, '.maple/inpaint'))).length).toBe(2);
    expect(new Uint8Array(await fs.readFile(join(root, 'photo.dng')))).toEqual(raw);
    await session.undoKeep();
    TestBed.tick();
    expect(savedRemovalRecords(await fs.readFile(join(root, 'photo.xmp'), 'utf8'))).toBeUndefined();
    expect(session.message()).toBe('Removal undone.');
  });
  it('cancel leaves no sidecar edit or published companion and restores the confirmed stack', async () => {
    await paint();
    await session.remove();
    await session.cancel();
    expect(session.phase()).toBe('ready');
    expect(session.preview()).toBeNull();
    expect(await fs.readFile(join(root, 'photo.xmp'), 'utf8')).toBe(prior);
    await expect(fs.stat(join(root, '.maple/inpaint'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(session.photo?.prior).toBe('[]');
  });
  it('protected paint cannot become removal and stroke undo removes the complete gesture', async () => {
    await paint();
    await session.protectSelection();
    await paint();
    expect(session.selection()).toHaveLength(0);
    expect(session.protection().length).toBeGreaterThan(0);
    session.clearProtection();
    await session.paint(
      [
        [3.5 / 16, 2.5 / 8],
        [2, 2],
        [8.5 / 16, 2.5 / 8],
      ],
      [16, 8],
    );
    expect(session.selection().length).toBeGreaterThan(0);
    const selected = session.selection().slice();
    await session.undoSelection();
    expect(session.selection()).toHaveLength(0);
    expect(session.canRedoSelection()).toBe(true);
    await session.redoSelection();
    expect(session.selection()).toEqual(selected);
    expect(session.canRedoSelection()).toBe(false);
  });
  it.each(['attribute', 'child'])(
    'replaces a recognized removal %s alias without duplicate records',
    async (form) => {
      const alias =
        form === 'attribute'
          ? prior.replace(
              '<rdf:Description',
              '<rdf:Description xmlns:m="http://ns.justmaple.app/1.0/" m:InpaintRemovals="[]"',
            )
          : prior.replace(
              '</rdf:Description>',
              '<m:InpaintRemovals xmlns:m="http://ns.justmaple.app/1.0/">[]</m:InpaintRemovals></rdf:Description>',
            );
      await fs.writeFile(join(root, 'photo.xmp'), alias);
      sidecars.rememberPassthrough(
        'photo',
        TestBed.inject(XmpParserService).parseAdjustmentModel(alias).passthrough,
      );
      await session.retryOpen();
      session.inference = {
        cancel: () => undefined,
        dispose: () => undefined,
        propose: async (...args: Parameters<typeof identityProposal>) => identityProposal(...args),
      } as unknown as RemovalInferenceClient;
      await paint();
      await session.remove();
      await session.keep();
      expect(session.message()).toBe('Removal saved.');
      const xml = await fs.readFile(join(root, 'photo.xmp'), 'utf8');
      expect(JSON.parse(savedRemovalRecords(xml)!)).toHaveLength(1);
      expect(xml).not.toContain('m:InpaintRemovals');
    },
  );
  it('keeps a failed cancellation visible until confirmed pixels can be restored', async () => {
    await paint();
    await session.remove();
    const prepare = session.pipeline.removal.prepareSaved.bind(session.pipeline.removal);
    const restore = vi
      .spyOn(session.pipeline.removal, 'prepareSaved')
      .mockRejectedValueOnce(new Error('restore fixture failed'));
    await session.cancel();
    expect(session.phase()).toBe('recovery');
    expect(session.preview()).not.toBeNull();
    expect(session.message()).toContain('restore fixture failed');
    expect(await fs.readFile(join(root, 'photo.xmp'), 'utf8')).toBe(prior);
    restore.mockImplementation(prepare);
    await session.cancel();
    expect(session.phase()).toBe('ready');
    expect(session.preview()).toBeNull();
  });
  it('drops a late inference result after cancellation without preparing or saving it', async () => {
    let release!: (value: RemovalProposal) => void;
    let result!: RemovalProposal;
    session.inference = {
      cancel: () => undefined,
      dispose: () => undefined,
      propose: (...args: Parameters<typeof identityProposal>) => {
        result = identityProposal(...args);
        return new Promise<RemovalProposal>((resolve) => {
          release = resolve;
        });
      },
    } as unknown as RemovalInferenceClient;
    await paint();
    const removing = session.remove();
    await vi.waitFor(() => expect(release).toBeDefined());
    await session.cancel();
    release(result);
    await removing;
    expect(session.phase()).toBe('ready');
    expect(session.draft).toBeUndefined();
    expect(session.preview()).toBeNull();
    expect(await fs.readFile(join(root, 'photo.xmp'), 'utf8')).toBe(prior);
  });
  it('refuses a changed sidecar at Keep and retains the inspectable draft', async () => {
    await paint();
    await session.remove();
    const changed = prior.replace(
      'foreign:Keep="untouched"',
      'papp:InpaintRemovals="[1]" foreign:Keep="untouched"',
    );
    await fs.writeFile(join(root, 'photo.xmp'), changed);
    await session.keep();
    expect(session.phase()).toBe('review');
    expect(session.preview()).not.toBeNull();
    expect(session.message()).toContain('photo changed');
    expect(await fs.readFile(join(root, 'photo.xmp'), 'utf8')).toBe(changed);
  });
});
