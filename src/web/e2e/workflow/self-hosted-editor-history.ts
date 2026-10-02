import { type ApplicationRef } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { LibraryStore } from '../../projects/maple-common/src/lib/state/library-store.service';
import { LibraryFetch } from '../../projects/maple-common/src/lib/state/library-fetch.service';
import { LibraryStateService } from '../../projects/maple-common/src/lib/state/library-state.service';
import { EditorStateService } from '../../projects/maple-common/src/lib/editor/editor-state.service';
import { RawPipelineService } from '../../projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service';
import { SidecarStore } from '../../projects/maple-common/src/lib/xmp/sidecar.store';
import { SIDECAR_CACHE } from '../../projects/maple-common/src/lib/xmp/sidecar-idb-cache';
import { WorkflowXmpService } from '../../projects/maple-common/src/lib/xmp/workflow-xmp.service';
import { XmpParserService } from '../../projects/maple-common/src/lib/xmp/xmp-parser.service';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';
import { provideSelfHostedWorkspace } from '../../projects/maple-common/src/lib/workspace/self-hosted-workspace.providers';
import type { ApiFolder } from '../../projects/maple-common/src/lib/workspace/server-library-io';
import type { Asset } from '../../projects/maple-common/src/lib/models/asset';

import { SidecarSaveStateService } from '../../projects/maple-common/src/lib/xmp/sidecar-save-state.service';
import type { SidecarWorkflow } from '../../projects/maple-common/src/lib/generated/workflow.generated';
import { SelfHostedWorkflowWriterService } from '../../projects/maple-common/src/lib/xmp/self-hosted-workflow-writer.service';

interface Source {
  input: string | null;
  key: string;
  path: string;
  id: string;
  library: ApiFolder;
}
interface Fixture {
  app: ApplicationRef;
  source: Source;
  id: string;
  library: LibraryStore;
  editor: EditorStateService;
  fetcher: LibraryFetch;
  sidecars: SidecarStore;
  core: WorkflowXmpService;
  parser: XmpParserService;
  gesture: (value: number) => void;
}
async function control<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) throw Error(`${response.status}: ${await response.text()}`);
  return response.json();
}
async function environment() {
  return createApplication({
    providers: [
      provideHttpClient(withFetch()),
      provideRouter([]),
      provideSelfHostedWorkspace(),
      { provide: LiveAnnouncer, useValue: { announce: async () => undefined } },
      { provide: RawPipelineService, useValue: {} },
      // Rendering is outside this gate. EditorState, LibraryStore, LibraryFetch,
      // HTTP, sidecar writers, native/WASM validators and IDB are production objects.
      {
        provide: LibraryStateService,
        deps: [LibraryStore, LibraryFetch],
        useFactory: (library: LibraryStore, fetcher: LibraryFetch) => ({
          adjustmentFor: (id: string) => library.adjustmentFor(id),
          updateAdjustment(id: string, patch: Parameters<LibraryStore['setAdjustment']>[1]) {
            library.setAdjustment(id, patch);
            fetcher.scheduleSidecarWrite(id, patch);
          },
        }),
      },
    ],
  });
}
function bind(fixture: Omit<Fixture, 'id' | 'gesture'>, source: Source, input: string | null) {
  const { library, editor, parser } = fixture;
  const id = `workflow-fixture:${source.key}/photo.dng`;
  const culling =
    input === null
      ? { rating: 0, flag: 'unflagged' as const, colorLabel: null, keywords: [] }
      : parser.parseCulling(input);
  const asset: Asset = {
    id,
    filename: 'photo.dng',
    folderId: source.library.id,
    ...culling,
    thumbnailGradient: '',
    aspectRatio: 1.5,
  };
  library.registeredFolders.set([source.library]);
  library.assets.set([asset]);
  library.adjustmentModels.set(
    new Map([
      [
        id,
        {
          ...defaultAdjustmentModel(),
          ...(input === null ? {} : parser.parseAdjustmentModel(input).model),
        },
      ],
    ]),
  );
  editor.bind(id);
  editor.armTool('exposure');
  return id;
}
async function stage(
  input: string | null,
  options: { workflow?: SidecarWorkflow; futureSchema?: boolean } = {},
): Promise<Fixture> {
  const source = await control<Source>('/workflow-fixture', { xml: input, ...options });
  const app = await environment();
  const base = {
    app,
    source,
    library: app.injector.get(LibraryStore),
    editor: app.injector.get(EditorStateService),
    fetcher: app.injector.get(LibraryFetch),
    sidecars: app.injector.get(SidecarStore),
    core: app.injector.get(WorkflowXmpService),
    parser: app.injector.get(XmpParserService),
  };
  const id = bind(base, source, source.input);
  return {
    ...base,
    id,
    gesture(value) {
      base.editor.commit('adjustment', `Exposure ${value}`);
      base.editor.beginGesture();
      base.editor.setArmedDisplayValue(value - 0.1);
      base.editor.setArmedDisplayValue(value);
      base.editor.endGesture();
    },
  };
}
async function rapid(f: Fixture) {
  for (const value of [0.25, 0.75, 1.25]) f.gesture(value);
  f.editor.undo();
  f.editor.redo();
  await f.fetcher.flushPendingXmpWrites();
}
async function preview(f: Fixture) {
  f.editor.setArmedDisplayValue(0.5);
  f.editor.setArmedDisplayValue(0.75);
  f.editor.commit();
  f.editor.endEdit();
  await f.fetcher.flushPendingXmpWrites();
}
async function retry(f: Fixture, laterPreview: boolean) {
  await control(`/workflow-fixture/${f.source.key}/obstruct`, {});
  f.gesture(1.25);
  let rejected = false;
  try {
    await f.fetcher.flushSidecarWrite(f.id);
  } catch {
    rejected = true;
  }
  if (!rejected) throw Error('Obstructed source falsely reported a successful save');
  await control(`/workflow-fixture/${f.source.key}/repair`, {});
  if (laterPreview) f.editor.setArmedDisplayValue(2.5);
  await f.fetcher.flushPendingXmpWrites();
}
async function navigation(f: Fixture, input: string | null, failed: boolean) {
  if (failed) await control(`/workflow-fixture/${f.source.key}/obstruct`, {});
  f.editor.commit();
  f.editor.setArmedDisplayValue(0.5);
  if (failed) {
    f.editor.endEdit();
    await f.fetcher.flushSidecarWrite(f.id).catch(() => undefined);
  }
  const replacement = await control<Source>('/workflow-fixture', { xml: input });
  const nextId = bind(f, replacement, input);
  f.library.setAdjustment(nextId, { exposure: 9 });
  if (failed) await control(`/workflow-fixture/${f.source.key}/repair`, {});
  await f.fetcher.flushPendingXmpWrites();
  const other = await control<{ xml: string | null }>(`/workflow-fixture/${replacement.key}`);
  if (other.xml !== input) throw Error('Old gesture wrote to a different source');
  if (f.library.adjustmentFor(nextId)().exposure !== 9)
    throw Error('Old gesture replaced a new model');
}
async function delayed(f: Fixture) {
  await control(`/workflow-fixture/${f.source.key}/block`, {});
  for (const value of [0.25, 0.75, 1.25]) f.gesture(value);
  f.editor.setArmedDisplayValue(2.5);
  await control(`/workflow-fixture/${f.source.key}/release`, {});
  await f.fetcher.flushPendingXmpWrites();
}
async function compaction(f: Fixture) {
  for (let index = 1; index <= 40; index++) {
    f.gesture(index / 10);
    await f.fetcher.flushPendingXmpWrites();
  }
}
async function modelLifetime(f: Fixture) {
  const writer = f.app.injector.get(SelfHostedWorkflowWriterService);
  for (let index = 0; index < 512; index++) {
    const path = `/unopened/${index}/photo.dng`;
    writer.noteModel(path, { ...defaultAdjustmentModel(), exposure: 9 });
    if (writer.latestModel(path) !== undefined)
      throw Error('An inactive preview model was retained indefinitely');
  }
  f.editor.commit();
  f.editor.setArmedDisplayValue(0.5);
  writer.noteModel('/another-source/photo.dng', { ...defaultAdjustmentModel(), exposure: 9 });
  if (writer.latestModel(f.source.path)?.exposure !== 0.5)
    throw Error('An unrelated edit replaced the open gesture model');
  f.editor.cancelEdit();
  if (writer.latestModel(f.source.path) !== undefined)
    throw Error('Cancelled gesture retained its preview model');
  await f.fetcher.flushPendingXmpWrites();
  f.editor.commit();
  f.editor.endEdit();
  if (writer.latestModel(f.source.path) !== undefined)
    throw Error('No-op gesture retained its preview model');
  f.gesture(1.25);
  if (writer.latestModel(f.source.path) !== undefined)
    throw Error('Closed gesture retained its preview model');
  await f.fetcher.flushPendingXmpWrites();
}
async function runScenario(f: Fixture, input: string | null, scenario: string) {
  const scenarios: Record<string, () => Promise<void>> = {
    rapid: () => rapid(f),
    preview: () => preview(f),
    retry: () => retry(f, false),
    'retry-preview': () => retry(f, true),
    navigation: () => navigation(f, input, false),
    'failed-navigation': () => navigation(f, input, true),
    delayed: () => delayed(f),
    compaction: () => compaction(f),
    'model-lifetime': () => modelLifetime(f),
  };
  const run = scenarios[scenario];
  if (!run) throw Error('Unknown qualification scenario');
  return run();
}
interface PersistedSource {
  xml: string | null;
  original: number[];
  state: { has_xmp: number; sidecar_ver: number };
  changes: unknown[];
  workflow: SidecarWorkflow | null;
}
async function reopenCache(path: string) {
  const reopened = await environment();
  try {
    const saved = await reopened.injector.get(SIDECAR_CACHE).get(path);
    const wire =
      saved === null ? null : await reopened.injector.get(WorkflowXmpService).read(saved.xml);
    return { saved, wire };
  } finally {
    reopened.destroy();
  }
}
function inspectPersisted(f: Fixture, result: PersistedSource) {
  const history = (result.workflow?.history ?? []).map((entry) => ({
    action: entry.action,
    exposure: f.parser.parseAdjustmentModel(entry.adjustmentXmp).model.exposure,
  }));
  return {
    history,
    exposure: result.xml === null ? null : f.parser.parseAdjustmentModel(result.xml).model.exposure,
    foreign: result.xml?.includes('crs:MaskGroup') ?? false,
  };
}
async function readResult(f: Fixture) {
  const result = await control<PersistedSource>(`/workflow-fixture/${f.source.key}`);
  // The API read is native-validated; reopening below independently validates
  // the published, cached XML through the real browser WASM worker.
  const details = inspectPersisted(f, result);
  const cache = await f.app.injector.get(SIDECAR_CACHE).get(f.source.path);
  f.app.destroy();
  const { saved, wire } = await reopenCache(f.source.path);
  return {
    ...result,
    ...details,
    historyCount: wire?.history.length ?? 0,
    snapshots: wire?.snapshots ?? [],
    cacheExact: cache?.xml === result.xml && saved?.xml === result.xml,
  };
}
export async function selfHostedEditorHistory(
  input: string | null,
  scenario: string,
  workflow?: SidecarWorkflow,
) {
  const f = await stage(input, { workflow });
  try {
    await runScenario(f, input, scenario);
    return await readResult(f);
  } finally {
    if (!f.app.destroyed) f.app.destroy();
  }
}
export async function selfHostedRejectedHistory(
  input: string,
  workflow: SidecarWorkflow,
  futureSchema: boolean,
) {
  const f = await stage(input, { workflow, futureSchema });
  try {
    f.gesture(1.25);
    const rejected = await f.fetcher.flushPendingXmpWrites().then(
      () => false,
      () => true,
    );
    const result = await control<PersistedSource>(`/workflow-fixture/${f.source.key}`);
    return {
      rejected,
      unchanged: result.xml === f.source.input,
      pending: f.sidecars.hasPendingSemantic(f.source.path),
      phase: f.app.injector.get(SidecarSaveStateService).phase(),
      original: result.original,
      changes: result.changes,
      state: result.state,
    };
  } finally {
    f.app.destroy();
  }
}
let concurrentClient: { app: ApplicationRef; sidecars: SidecarStore } | null = null;
export async function selfHostedConcurrentStage(input: string) {
  return control<Source>('/workflow-fixture', { xml: input });
}
export async function selfHostedConcurrentGate(source: Source, open: boolean) {
  return control(`/workflow-fixture/${source.key}/${open ? 'end-race' : 'race'}`, {});
}
export async function selfHostedConcurrentClient(source: Source, index: number, retry: boolean) {
  if (!concurrentClient) {
    const app = await environment();
    concurrentClient = { app, sidecars: app.injector.get(SidecarStore) };
  }
  const { app, sidecars } = concurrentClient;
  const parser = app.injector.get(XmpParserService);
  const before = {
    ...defaultAdjustmentModel(),
    ...parser.parseAdjustmentModel(source.input ?? '').model,
  };
  const operation = retry
    ? sidecars.retrySemantic(source.path)
    : sidecars.commitSemantic(source.id, source.path, {
        before,
        after: { ...before, exposure: (index + 1) / 10 },
        culling: parser.parseCulling(source.input ?? ''),
        cullingPatch: {},
        action: 'preset',
        label: `Client ${index}`,
      });
  const accepted = await operation.then(
    () => true,
    () => false,
  );
  return { accepted, pending: sidecars.hasPendingSemantic(source.path) };
}
export async function selfHostedConcurrentRead(source: Source) {
  const app = await environment();
  try {
    const persisted = await control<PersistedSource>(`/workflow-fixture/${source.key}`);
    const wire =
      persisted.xml === null
        ? null
        : await app.injector.get(WorkflowXmpService).read(persisted.xml);
    const parser = app.injector.get(XmpParserService);
    return {
      exposures: (wire?.history ?? [])
        .map((entry) => parser.parseAdjustmentModel(entry.adjustmentXmp).model.exposure)
        .sort(),
      distinctActions: new Set(wire?.history.map((entry) => entry.id)).size,
      original: persisted.original,
      changes: persisted.changes.length,
      version: persisted.state.sidecar_ver,
    };
  } finally {
    app.destroy();
  }
}
