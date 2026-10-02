import { createEnvironmentInjector, Injector, type EnvironmentInjector } from '@angular/core';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { EditorStateService } from '../../projects/maple-common/src/lib/editor/editor-state.service';
import { EditorWorkflowHistoryService } from '../../projects/maple-common/src/lib/editor/editor-workflow-history.service';
import { EditorWorkflowCommandsService } from '../../projects/maple-common/src/lib/editor/editor-workflow-commands.service';
import { WorkflowVariantStoreService } from '../../projects/maple-common/src/lib/xmp/workflow-variant-store.service';
import { LibraryStore } from '../../projects/maple-common/src/lib/state/library-store.service';
import { LibraryStateService } from '../../projects/maple-common/src/lib/state/library-state.service';
import { LIBRARY_BACKEND } from '../../projects/maple-common/src/lib/api/library-backend.token';
import { RawPipelineService } from '../../projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service';
import { FolderAccessService } from '../../projects/maple-common/src/lib/folder-access/folder-access.service';
import { XmpStoreService } from '../../projects/maple-common/src/lib/xmp/xmp-store.service';
import { HostedWorkflowWriterService } from '../../projects/maple-common/src/lib/xmp/hosted-workflow-writer.service';
import { XmpParserService } from '../../projects/maple-common/src/lib/xmp/xmp-parser.service';
import { XmpSerializerService } from '../../projects/maple-common/src/lib/xmp/xmp-serializer.service';
import { WorkflowXmpService } from '../../projects/maple-common/src/lib/xmp/workflow-xmp.service';
import { SidecarSaveStateService } from '../../projects/maple-common/src/lib/xmp/sidecar-save-state.service';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';
import type { Asset } from '../../projects/maple-common/src/lib/models/asset';
import type { MapleFolderHandle } from '../../projects/maple-common/src/lib/folder-access/folder-access.types';

const culling = { rating: 0, flag: 'unflagged' as const, colorLabel: null, keywords: [] };
const environment = () =>
  createEnvironmentInjector(
    [
      EditorStateService,
      EditorWorkflowHistoryService,
      EditorWorkflowCommandsService,
      WorkflowVariantStoreService,
      LibraryStore,
      FolderAccessService,
      XmpStoreService,
      HostedWorkflowWriterService,
      XmpParserService,
      XmpSerializerService,
      WorkflowXmpService,
      SidecarSaveStateService,
      { provide: LIBRARY_BACKEND, useValue: 'hosted' },
      { provide: LiveAnnouncer, useValue: { announce: async () => undefined } },
      { provide: RawPipelineService, useValue: {} },
      // The unrelated render/library orchestration is outside this gate. The editor,
      // signal store, XMP writer, WASM worker and filesystem are the production objects.
      {
        provide: LibraryStateService,
        deps: [LibraryStore, XmpStoreService],
        useFactory: (library: LibraryStore, writer: XmpStoreService) => ({
          adjustmentFor: (id: string) => library.adjustmentFor(id),
          updateAdjustment(id: string, patch: Parameters<LibraryStore['setAdjustment']>[1]) {
            library.setAdjustment(id, patch);
            const folder = library.currentFolder();
            const asset = library.findAsset(id);
            if (folder && asset)
              writer.scheduleWrite(id, folder, asset.filename, library.adjustmentFor(id)(), {
                rating: asset.rating,
                flag: asset.flag,
                colorLabel: asset.colorLabel,
                keywords: asset.keywords,
              });
          },
        }),
      },
    ],
    Injector.NULL as EnvironmentInjector,
  );

interface EditorFixture {
  env: EnvironmentInjector;
  native: FileSystemDirectoryHandle;
  folder: MapleFolderHandle;
  input: string;
  access: FolderAccessService;
  core: WorkflowXmpService;
  writer: XmpStoreService;
  library: LibraryStore;
  editor: EditorStateService;
  read: () => Promise<string>;
  gesture: (value: number) => void;
}

async function rapid(fixture: EditorFixture) {
  const { gesture, editor, writer } = fixture;
  for (const value of [0.25, 0.75, 1.25]) gesture(value);
  editor.undo();
  editor.redo();
  await writer.flushAsset('photo');
}

async function preview(fixture: EditorFixture) {
  const { editor, writer, core, read } = fixture;
  editor.setArmedDisplayValue(0.5);
  editor.setArmedDisplayValue(0.75);
  await writer.flushAsset('photo');
  editor.commit();
  editor.endEdit();
  if ((await core.read(await read())) !== null) throw Error('Preview/no-op authored history');
}

async function retry(fixture: EditorFixture, laterPreview: boolean) {
  const { native, writer, access, folder, input, editor } = fixture;
  await obstructPublication(fixture);
  await native.removeEntry('photo.xmp', { recursive: true });
  await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(input));
  // A later preview save retries the captured 1.25 action, not its 2.5 model.
  if (laterPreview) editor.setArmedDisplayValue(2.5);
  await writer.flushAsset('photo');
}

async function scope(fixture: EditorFixture) {
  const { editor, access, input, library, writer } = fixture;
  editor.commit();
  editor.setArmedDisplayValue(0.5);
  const replacement = await replacementFolder(fixture);
  library.setAdjustment('photo', { exposure: 9 });
  editor.bind('photo');
  await writer.flushAsset('photo');
  if (new TextDecoder().decode(await access.readFile(replacement, 'photo.xmp')) !== input)
    throw Error('Old gesture overwrote a different folder');
  if (library.adjustmentFor('photo')().exposure !== 9)
    throw Error('Old gesture replaced new model');
}

async function concurrent(fixture: EditorFixture) {
  const { folder } = fixture;
  const competitors = Array.from({ length: 8 }, () => environment());
  try {
    await Promise.all(
      competitors.map((competitor, index) =>
        competitor
          .get(XmpStoreService)
          .commitSemantic(
            'photo',
            folder,
            'photo.dng',
            { ...defaultAdjustmentModel(), exposure: (index + 1) / 10 },
            culling,
            'preset',
            `Preset ${index + 1}`,
          ),
      ),
    );
  } finally {
    competitors.forEach((competitor) => competitor.destroy());
  }
}

async function identity(fixture: EditorFixture) {
  const { core, input, access, folder, gesture, writer, read } = fixture;
  const id = crypto.randomUUID();
  const named = await core.embed(
    { schemaVersion: 1, variantId: id, variantName: 'Named', snapshots: [], history: [] },
    input,
  );
  await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(named));
  gesture(1.25);
  let rejected = false;
  try {
    await writer.flushAsset('photo');
  } catch {
    rejected = true;
  }
  if (!rejected || (await read()) !== named) throw Error('Named sidecar was treated as primary');
  return { rejected, unchanged: true };
}

async function future(fixture: EditorFixture) {
  const { core, input, access, folder, gesture, writer, read } = fixture;
  const record = {
    schemaVersion: 1,
    variantId: 'primary',
    variantName: 'Primary',
    snapshots: [],
    history: [],
  };
  const future = (await core.embed(record, input)).replace(
    '<papp:SchemaVersion>1',
    '<papp:SchemaVersion>2',
  );
  await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(future));
  gesture(1.25);
  let rejected = false;
  try {
    await writer.flushAsset('photo');
  } catch {
    rejected = true;
  }
  if (!rejected || (await read()) !== future) throw Error('Unsupported Workflow was overwritten');
  return { rejected, unchanged: true };
}

async function compaction(fixture: EditorFixture) {
  const { core, input, access, folder, gesture, writer } = fixture;
  const initial = await core.snapshot(
    {
      id: crypto.randomUUID(),
      name: 'Original',
      createdAtMs: Date.now(),
      adjustmentXmp: await core.checkpoint(input),
    },
    input,
  );
  await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(initial));
  for (let index = 1; index <= 40; index++) {
    gesture(index / 10);
    await writer.flushAsset('photo');
  }
}

async function retryAcrossNavigation(fixture: EditorFixture) {
  const { native, folder, access, input, gesture, writer, editor } = fixture;
  await obstructPublication(fixture);
  const replacement = await replacementFolder(fixture);
  editor.bind('photo');
  gesture(0.5);
  await writer.flushAsset('photo');
  await native.removeEntry('photo.xmp', { recursive: true });
  await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(input));
  await writer.flushAll();
  const saved = new TextDecoder().decode(await access.readFile(replacement, 'photo.xmp'));
  if (fixture.env.get(XmpParserService).parseAdjustmentModel(saved).model.exposure !== 0.5)
    throw Error('Retry replaced the new folder sidecar');
}

async function obstructPublication(fixture: EditorFixture) {
  await fixture.native.removeEntry('photo.xmp');
  await fixture.native.getDirectoryHandle('photo.xmp', { create: true });
  fixture.gesture(1.25);
  let rejected = false;
  try {
    await fixture.writer.flushAsset('photo');
  } catch {
    rejected = true;
  }
  if (!rejected || fixture.env.get(SidecarSaveStateService).phase() !== 'error')
    throw Error('Actual filesystem failure was not reported');
}

async function replacementFolder(fixture: EditorFixture) {
  const native = await fixture.native.getDirectoryHandle('replacement', { create: true });
  const folder = { native, name: 'replacement', read: true, write: true };
  await fixture.access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(fixture.input));
  fixture.library.currentFolder.set(folder);
  return folder;
}

const scenarios: Record<string, (fixture: EditorFixture) => Promise<unknown>> = {
  rapid,
  preview,
  navigationRetry: retryAcrossNavigation,
  retry: (fixture) => retry(fixture, true),
  'retry-flush': (fixture) => retry(fixture, false),
  scope,
  concurrent,
  identity,
  future,
  compaction,
};

export async function editorHistory(input: string, scenario: string) {
  const root = await navigator.storage.getDirectory();
  const name = 'maple-editor-history-' + crypto.randomUUID();
  const native = await root.getDirectoryHandle(name, { create: true });
  const folder: MapleFolderHandle = { native, name, read: true, write: true };
  let env = environment();
  const original = new Uint8Array([1, 0, 255, 42]);
  const asset: Asset = {
    id: 'photo',
    filename: 'photo.dng',
    folderId: 'folder',
    ...culling,
    thumbnailGradient: '',
    aspectRatio: 1.5,
  };
  try {
    const access = env.get(FolderAccessService);
    const parser = env.get(XmpParserService);
    const core = env.get(WorkflowXmpService);
    const writer = env.get(XmpStoreService);
    const library = env.get(LibraryStore);
    const editor = env.get(EditorStateService);
    const read = async () => new TextDecoder().decode(await access.readFile(folder, 'photo.xmp'));
    await access.writeFile(folder, asset.filename, original);
    await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(input));
    library.currentFolder.set(folder);
    library.assets.set([asset]);
    library.adjustmentModels.set(
      new Map([
        ['photo', { ...defaultAdjustmentModel(), ...parser.parseAdjustmentModel(input).model }],
      ]),
    );
    editor.bind('photo');
    editor.armTool('exposure');
    const gesture = (value: number) => {
      editor.commit();
      editor.beginGesture();
      editor.setArmedDisplayValue(value - 0.1);
      editor.setArmedDisplayValue(value);
      editor.endGesture();
    };
    const run = scenarios[scenario];
    if (!run) throw Error('Unknown editor scenario');
    const rejected = await run({
      env,
      native,
      folder,
      input,
      access,
      core,
      writer,
      library,
      editor,
      read,
      gesture,
    });
    if (rejected) return rejected;
    const saved = await read();
    const workflow = await core.read(saved);
    const active = await core.checkpoint(saved);
    const values = workflow
      ? workflow.history.map(
          (item) => parser.parseAdjustmentModel(item.adjustmentXmp).model.exposure,
        )
      : [];
    const checkpointHasForeign =
      workflow?.history.every((item) => item.adjustmentXmp.includes('vendor:Audit')) ?? true;
    const sourceBytes = Array.from(await access.readFile(folder, asset.filename));
    const phase = env.get(SidecarSaveStateService).phase();
    env.destroy();
    env = environment();
    const freshXml = new TextDecoder().decode(
      await env.get(FolderAccessService).readFile(folder, 'photo.xmp'),
    );
    const reopened = await env.get(WorkflowXmpService).read(freshXml);
    return {
      workflow,
      reopened,
      values,
      checkpointHasForeign,
      exposure: parser.parseAdjustmentModel(active).model.exposure,
      phase,
      foreign: saved.includes('vendor:Audit'),
      original: sourceBytes,
    };
  } finally {
    env.destroy();
    await root.removeEntry(name, { recursive: true });
  }
}
