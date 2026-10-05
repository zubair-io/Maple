import { opfsWriteFailure } from './opfs-write-failure';
import './cold-profile-ui';
import { geometryGestureWorkflow } from './geometry-gesture-workflow';
import { lensGestureWorkflow } from './lens-gesture-workflow';
import { lensIndexCleanupBoundary } from './lens-index-cleanup';
import { comparisonWorkflow } from './comparison';
import { Component, createComponent, inject, type ApplicationRef } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { createApplication } from '@angular/platform-browser';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { provideHostedWorkspace } from '../../projects/maple-common/src/lib/workspace/hosted-workspace.providers';
import { WorkflowControlsComponent } from '../../projects/maple-common/src/lib/editor/workflow-controls.component';
import { EditorStateService } from '../../projects/maple-common/src/lib/editor/editor-state.service';
import { LibraryStateService } from '../../projects/maple-common/src/lib/state/library-state.service';
import { LibraryStore } from '../../projects/maple-common/src/lib/state/library-store.service';
import { RawPipelineService } from '../../projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service';
import { FolderAccessService } from '../../projects/maple-common/src/lib/folder-access/folder-access.service';
import { XmpStoreService } from '../../projects/maple-common/src/lib/xmp/xmp-store.service';
import { XmpParserService } from '../../projects/maple-common/src/lib/xmp/xmp-parser.service';
import { XmpAdjustmentRestoreService } from '../../projects/maple-common/src/lib/xmp/xmp-adjustment-restore.service';
import { WorkflowXmpService } from '../../projects/maple-common/src/lib/xmp/workflow-xmp.service';
import { WorkflowVariantStoreService } from '../../projects/maple-common/src/lib/xmp/workflow-variant-store.service';
import { SERVER_WORKSPACE_PERSISTENCE } from '../../projects/maple-common/src/lib/workspace/workspace-persistence';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';
import { firstValueFrom } from 'rxjs';
import { stage, control, type Fixture } from './self-hosted-editor-history';
import type { MapleFolderHandle } from '../../projects/maple-common/src/lib/folder-access/folder-access.types';

@Component({
  selector: 'workflow-qualification',
  imports: [WorkflowControlsComponent, NgTemplateOutlet],
  template: `<main class="flex min-h-screen items-start gap-2 bg-surface p-4">
    <editor-workflow-controls #workflow />
    <ng-container [ngTemplateOutlet]="workflow.triggerTemplate() ?? null" />
    <button aria-label="Undo" [disabled]="editor.workflowBusy()" (click)="editor.undo()">
      Undo
    </button>
    <button aria-label="Redo" [disabled]="editor.workflowBusy()" (click)="editor.redo()">
      Redo
    </button>
  </main>`,
})
class WorkflowQualification {
  readonly editor = inject(EditorStateService);
}

interface HostedFixture {
  app: ApplicationRef;
  folder: MapleFolderHandle;
  native: FileSystemDirectoryHandle;
  name: string;
  input: string;
}
let active: {
  app: ApplicationRef;
  hosted: HostedFixture | null;
  server: Fixture | null;
  host: HTMLElement;
} | null = null;
let unlock: (() => void) | null = null;
const extraFolders: string[] = [];
let navigatedFolder: MapleFolderHandle | null = null;
let navigatedExpected: string | null = null;
let navigatedServerKey: string | null = null;
let lateRead: Promise<void> | null = null;

async function hosted(input: string | null, existing?: HostedFixture): Promise<HostedFixture> {
  const root = await navigator.storage.getDirectory();
  const name = existing?.name ?? 'maple-workflow-controls-' + crypto.randomUUID();
  const native = existing?.native ?? (await root.getDirectoryHandle(name, { create: true }));
  const folder = { native, name, read: true, write: true };
  const app = await createApplication({
    providers: [
      provideHostedWorkspace(),
      { provide: LiveAnnouncer, useValue: { announce: async () => undefined } },
      { provide: RawPipelineService, useValue: {} },
      // Only render orchestration is outside this gate; all XMP, CAS, caches and UI are real.
      {
        provide: LibraryStateService,
        deps: [LibraryStore, XmpStoreService],
        useFactory: (library: LibraryStore, writer: XmpStoreService) => ({
          adjustmentFor: (id: string) => library.adjustmentFor(id),
          updateAdjustment(id: string, patch: Parameters<LibraryStore['setAdjustment']>[1]) {
            library.setAdjustment(id, patch);
            const asset = library.findAsset(id)!;
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
  });
  const access = app.injector.get(FolderAccessService);
  if (!existing) {
    await access.writeFile(folder, 'photo.dng', new Uint8Array([1, 0, 255, 42]));
    if (input !== null)
      await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(input));
  }
  initializeHosted(app, folder, input);
  return { app, folder, native, name, input: input ?? '' };
}

function initializeHosted(
  app: ApplicationRef,
  folder: MapleFolderHandle,
  input: string | null,
): void {
  const library = app.injector.get(LibraryStore);
  const parser = app.injector.get(XmpParserService);
  const culling =
    input === null
      ? { rating: 0, flag: 'unflagged' as const, colorLabel: null, keywords: [] }
      : parser.parseCulling(input);
  library.currentFolder.set(folder);
  library.assets.set([
    {
      id: 'photo',
      filename: 'photo.dng',
      folderId: 'folder',
      thumbnailGradient: '',
      aspectRatio: 1.5,
      ...culling,
    },
  ]);
  library.adjustmentModels.set(
    new Map([
      [
        'photo',
        {
          ...defaultAdjustmentModel(),
          ...(input === null ? {} : parser.parseAdjustmentModel(input).model),
        },
      ],
    ]),
  );
  const editor = app.injector.get(EditorStateService);
  editor.bind('photo');
  editor.armTool('exposure');
}

async function read(): Promise<string> {
  if (!active) throw Error('No owned workflow UI fixture');
  if (active.server)
    return (await control<{ xml: string }>(`/workflow-fixture/${active.server.source.key}`)).xml;
  const access = active.app.injector.get(FolderAccessService);
  return new TextDecoder().decode(await access.readFile(active.hosted!.folder, 'photo.xmp'));
}
async function replace(xml: string): Promise<void> {
  if (!active) throw Error('No owned workflow UI fixture');
  if (active.server) {
    const persistence = active.app.injector.get(SERVER_WORKSPACE_PERSISTENCE)!;
    await firstValueFrom(persistence.writeSidecar(active.server.source.path, xml));
  } else {
    await active.app.injector
      .get(WorkflowVariantStoreService)
      .write(active.hosted!.folder, 'photo.xmp', 'primary', xml);
  }
  const editor = active.app.injector.get(EditorStateService);
  const commands = editor.workflowCommands;
  const source = commands.capture(editor.imageId()!, editor.currentAdjustment()!)!;
  commands.apply(source, await read());
}
async function dispose(): Promise<void> {
  if (!active) return;
  const fixture = active;
  active = null;
  fixture.app.destroy();
  fixture.host.remove();
  unlock?.();
  unlock = null;
  const root = await navigator.storage.getDirectory();
  for (const name of extraFolders.splice(0)) await root.removeEntry(name, { recursive: true });
  navigatedFolder = null;
  navigatedExpected = null;
  navigatedServerKey = null;
  if (fixture.hosted)
    await (
      await navigator.storage.getDirectory()
    ).removeEntry(fixture.hosted.name, { recursive: true });
}

function attach(app: ApplicationRef, local: HostedFixture | null, server: Fixture | null): void {
  const host = document.createElement('workflow-qualification');
  document.body.append(host);
  const component = createComponent(WorkflowQualification, {
    environmentInjector: app.injector,
    hostElement: host,
  });
  app.attachView(component.hostView);
  active = { app, hosted: local, server, host };
  app.tick();
}
Reflect.set(window, 'workflowUI', {
  opfsWriteFailure,
  lensIndexCleanupBoundary,
  lensGestureWorkflow,
  geometryGestureWorkflow,
  comparisonWorkflow,
  async mount(input: string | null, backend: 'hosted' | 'self-hosted') {
    await dispose();
    const server = backend === 'self-hosted' ? await stage(input) : null;
    const local = backend === 'hosted' ? await hosted(input) : null;
    const app = server?.app ?? local!.app;
    attach(app, local, server);
  },
  async reopen() {
    const xml = await read();
    const previous = active!;
    previous.app.destroy();
    previous.host.remove();
    const server = previous.server ? await stage(xml, {}, previous.server.source) : null;
    const local = previous.hosted ? await hosted(xml, previous.hosted) : null;
    attach(server?.app ?? local!.app, local, server);
  },
  dispose,
  read,
  replace,
  async variantState() {
    if (!active) throw Error('No owned workflow UI fixture');
    const editor = active.app.injector.get(EditorStateService);
    const source = editor.workflowCommands.capture(editor.imageId()!, editor.currentAdjustment()!);
    if (!source) throw Error('No writable editor source');
    const document = await editor.workflowCommands.load(source);
    const parser = active.app.injector.get(XmpParserService);
    const primary = await read();
    const access = active.app.injector.get(FolderAccessService);
    const original = active.hosted
      ? Array.from(await access.readFile(active.hosted.folder, 'photo.dng'))
      : (await control<{ original: number[] }>(`/workflow-fixture/${active.server!.source.key}`))
          .original;
    return {
      variantId: source.variantId,
      record: document.record,
      xml: document.xml,
      primary,
      model: editor.currentAdjustment(),
      culling: document.xml === null ? null : parser.parseCulling(document.xml),
      original,
      undoCount: editor.undoHistory().length,
    };
  },
  status() {
    const editor = active!.app.injector.get(EditorStateService);
    return {
      busy: editor.workflowBusy(),
      error: editor.workflowError(),
      undoCount: editor.undoHistory().length,
    };
  },
  async state() {
    const editor = active!.app.injector.get(EditorStateService);
    const core = active!.app.injector.get(WorkflowXmpService);
    const xml = await read();
    const library = active!.app.injector.get(LibraryStore);
    const path = active!.server?.source.path;
    const original = active!.server
      ? await control<{ original: number[]; state: unknown; changes: unknown[] }>(
          `/workflow-fixture/${active!.server.source.key}`,
        )
      : {
          original: Array.from(
            await active!.app.injector
              .get(FolderAccessService)
              .readFile(active!.hosted!.folder, 'photo.dng'),
          ),
        };
    return {
      xml,
      checkpoint: await core.checkpoint(xml),
      workflow: await core.read(xml),
      model: editor.currentAdjustment(),
      asset: library.findAsset(editor.imageId()!),
      busy: editor.workflowBusy(),
      error: editor.workflowError(),
      undoCount: editor.undoHistory().length,
      last: editor.lastCommittedTransaction()?.kind,
      path,
      ...original,
    };
  },
  async edit(value: number) {
    const editor = active!.app.injector.get(EditorStateService);
    editor.commit();
    editor.setArmedDisplayValue(value);
    editor.endEdit();
    await editor.workflowCommands.load(
      editor.workflowCommands.capture(editor.imageId()!, editor.currentAdjustment()!)!,
    );
  },
  async cull() {
    const library = active!.app.injector.get(LibraryStore);
    const editor = active!.app.injector.get(EditorStateService);
    const id = editor.imageId()!;
    const culling = {
      rating: 5,
      flag: 'pick' as const,
      colorLabel: 'blue' as const,
      keywords: ['authored-after-snapshot'],
    };
    library.setCulling(id, culling);
    if (active!.server) active!.server.fetcher.scheduleSidecarWrite(id);
    else
      active!.app.injector
        .get(XmpStoreService)
        .scheduleWrite(
          id,
          active!.hosted!.folder,
          'photo.dng',
          editor.currentAdjustment()!,
          culling,
        );
    await editor.workflowCommands.load(
      editor.workflowCommands.capture(id, editor.currentAdjustment()!)!,
    );
  },
  async obstruct() {
    const xml = await read();
    if (active!.server)
      await control(`/workflow-fixture/${active!.server.source.key}/obstruct`, {});
    else {
      await active!.hosted!.native.removeEntry('photo.xmp');
      await active!.hosted!.native.getDirectoryHandle('photo.xmp', { create: true });
    }
    return xml;
  },
  async repair(xml: string) {
    if (active!.server) {
      await control(`/workflow-fixture/${active!.server.source.key}/repair`, {});
      await firstValueFrom(
        active!.app.injector
          .get(SERVER_WORKSPACE_PERSISTENCE)!
          .writeSidecar(active!.server.source.path, xml),
      );
    } else {
      await active!.hosted!.native.removeEntry('photo.xmp', { recursive: true });
      await active!.app.injector
        .get(FolderAccessService)
        .writeFile(active!.hosted!.folder, 'photo.xmp', new TextEncoder().encode(xml));
    }
  },
  async loseResponse() {
    if (!active!.server) throw Error('Lost HTTP responses require the real API fixture');
    await control(`/workflow-fixture/${active!.server.source.key}/lose-response`, {});
  },
  startLateRead() {
    if (!active!.server) throw Error('The delayed HTTP read requires a Self Hosted source.');
    const restore = active!.app.injector.get(XmpAdjustmentRestoreService);
    restore.invalidateForAsset(active!.server.id);
    lateRead = restore.restoreForAsset(active!.server.id);
  },
  async finishLateRead() {
    await lateRead;
    const current = await active!.app.injector
      .get(XmpAdjustmentRestoreService)
      .loadForWrite(active!.server!.id);
    return current;
  },
  async blockPublication() {
    if (active!.server) {
      await control(`/workflow-fixture/${active!.server.source.key}/block`, {});
      return;
    }
    await new Promise<void>((entered) => {
      const release = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      void navigator.locks.request('maple-workflow-variant:primary', async () => {
        entered();
        await release;
      });
    });
  },
  async releasePublication() {
    if (active!.server) await control(`/workflow-fixture/${active!.server.source.key}/release`, {});
    unlock?.();
    unlock = null;
  },
  async navigate() {
    const editor = active!.app.injector.get(EditorStateService);
    const library = active!.app.injector.get(LibraryStore);
    const id = active!.server ? await newServerSource() : await newHostedSource();
    library.assets.set([
      {
        id,
        filename: 'photo.dng',
        folderId: 'new-source',
        thumbnailGradient: '',
        aspectRatio: 1.5,
        rating: 0,
        flag: 'unflagged',
        colorLabel: null,
        keywords: [],
      },
    ]);
    library.adjustmentModels.set(new Map([[id, { ...defaultAdjustmentModel(), exposure: 9 }]]));
    editor.bind(id);
  },
  async navigationResult() {
    const editor = active!.app.injector.get(EditorStateService);
    const next = navigatedFolder
      ? new TextDecoder().decode(
          await active!.app.injector
            .get(FolderAccessService)
            .readFile(navigatedFolder, 'photo.xmp'),
        )
      : (await control<{ xml: string }>(`/workflow-fixture/${navigatedServerKey}`)).xml;
    return {
      model: editor.currentAdjustment(),
      undoCount: editor.undoHistory().length,
      replayRetained: editor.workflowReplay !== null,
      nextUnchanged: next === navigatedExpected,
      old: await read(),
    };
  },
  ready: true,
});

async function newHostedSource(): Promise<string> {
  const name = 'maple-workflow-navigation-' + crypto.randomUUID();
  extraFolders.push(name);
  const native = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle(name, { create: true });
  navigatedFolder = { native, name, read: true, write: true };
  navigatedExpected = await read();
  const access = active!.app.injector.get(FolderAccessService);
  await access.writeFile(navigatedFolder, 'photo.dng', new Uint8Array([1, 0, 255, 42]));
  await access.writeFile(navigatedFolder, 'photo.xmp', new TextEncoder().encode(navigatedExpected));
  active!.app.injector.get(LibraryStore).currentFolder.set(navigatedFolder);
  return 'photo';
}
async function newServerSource(): Promise<string> {
  navigatedExpected = await read();
  const source = await control<{ key: string }>('/workflow-fixture', { xml: navigatedExpected });
  navigatedServerKey = source.key;
  return `workflow-fixture:${source.key}/photo.dng`;
}
