import { createComponent } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { ImageCanvasComponent } from '../../projects/maple-common/src/lib/components/image-canvas/image-canvas.component';
import { ImageCanvasService } from '../../projects/maple-common/src/lib/components/image-canvas/image-canvas.service';
import { LibraryStore } from '../../projects/maple-common/src/lib/state/library-store.service';
import { LibraryStateService } from '../../projects/maple-common/src/lib/state/library-state.service';
import { FolderAccessService } from '../../projects/maple-common/src/lib/folder-access/folder-access.service';
import { provideHostedWorkspace } from '../../projects/maple-common/src/lib/workspace/hosted-workspace.providers';
import { provideSelfHostedWorkspace } from '../../projects/maple-common/src/lib/workspace/self-hosted-workspace.providers';
import type { ApiFolder } from '../../projects/maple-common/src/lib/workspace/server-library-io';
import { XmpSerializerService } from '../../projects/maple-common/src/lib/xmp/xmp-serializer.service';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';
import {
  CanvasColorSpacePref,
  type CanvasColorSpace,
} from '../../projects/maple-common/src/lib/raw-pipeline/canvas-color-space.pref';
import { GpuLiveRenderGate } from '../../projects/maple-common/src/lib/raw-pipeline/gpu-live-render.gate';
import { EditorStateService } from '../../projects/maple-common/src/lib/editor/editor-state.service';
import { EditorWorkflowHistoryService } from '../../projects/maple-common/src/lib/editor/editor-workflow-history.service';
import { EditorWorkflowVariantsService } from '../../projects/maple-common/src/lib/editor/editor-workflow-variants.service';
import { control } from './self-hosted-editor-history';

async function until(ready: () => boolean, label: string) {
  const deadline = performance.now() + 60000;
  while (!ready()) {
    if (performance.now() > deadline) throw Error('Timed out: ' + label);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}
function pixel(source: CanvasImageSource, width: number, height: number) {
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext('2d', { colorSpace: 'display-p3' })!;
  context.drawImage(source, Math.floor(width / 2), Math.floor(height / 2), 1, 1, 0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
}
const delta = (a: number[], b: number[]) =>
  Math.max(...a.map((value, i) => Math.abs(value - b[i])));

/** Shipping canvas, RAW worker and real OPFS/HTTP XMP. No renderer or storage substitutes. */
export async function comparisonWorkflow(
  backend: 'hosted' | 'self-hosted',
  gpu: boolean,
  camera = false,
  camera100mp = false,
  colorSpace?: CanvasColorSpace,
) {
  const initial = new XmpSerializerService().serialize({
    ...defaultAdjustmentModel(),
    exposure: 0.25,
  });
  const fixture = await control<{ key: string; path: string; library: ApiFolder }>(
    '/workflow-fixture',
    { xml: initial, synthetic: true, camera, camera100mp },
  );
  const readOriginal = async () => {
    const response = await fetch('/workflow-fixture/' + fixture.key + '/raw');
    if (!response.ok) throw Error('Original read failed');
    return new Uint8Array(await response.arrayBuffer());
  };
  const bytes = await readOriginal();
  const sourceHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  if (
    camera100mp &&
    (bytes.length !== 129467390 ||
      sourceHash !== 'f4b60b3672bdf7ff7f4376fba9da1b1d22c925ebc3e16baa5fd4a64fa1045aa5')
  ) {
    throw Error('100MP fixture does not match the committed canonical fingerprint');
  }
  const app = await createApplication({
    providers: [
      backend === 'hosted' ? provideHostedWorkspace() : provideSelfHostedWorkspace(),
      provideHttpClient(withFetch()),
      provideRouter([]),
      { provide: LiveAnnouncer, useValue: { announce: async () => undefined } },
    ],
  });
  const root = await navigator.storage.getDirectory();
  const name = 'maple-comparison-' + crypto.randomUUID();
  const native = await root.getDirectoryHandle(name, { create: true });
  const folder = { native, name, read: true, write: true };
  const host = document.createElement('editor-image-canvas');
  host.style.cssText =
    'width:800px;height:600px;position:relative;display:flex;flex-direction:column';
  document.body.appendChild(host);
  try {
    const library = app.injector.get(LibraryStateService);
    const access = app.injector.get(FolderAccessService);
    const editor = app.injector.get(EditorStateService);
    app.injector.get(GpuLiveRenderGate).apply(gpu);
    if (colorSpace) app.injector.get(CanvasColorSpacePref).set(colorSpace);
    let id: string;
    if (backend === 'hosted') {
      await access.writeFile(folder, 'photo.dng', bytes);
      await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(initial));
      await library.openFolder(folder);
      id = library.assets()[0].id;
    } else {
      const store = app.injector.get(LibraryStore);
      store.registeredFolders.set([fixture.library]);
      id = `workflow-fixture:${fixture.key}/photo.dng`;
      store.assets.set([
        {
          id,
          filename: 'photo.dng',
          folderId: fixture.library.id,
          rating: 0,
          flag: 'unflagged',
          colorLabel: null,
          keywords: [],
          thumbnailGradient: '',
          aspectRatio: 1,
        },
      ]);
    }
    library.focusedAssetId.set(id);
    editor.bind(id);
    const component = createComponent(ImageCanvasComponent, {
      environmentInjector: app.injector,
      hostElement: host,
    });
    component.setInput('hideToolbar', true);
    app.attachView(component.hostView);
    app.tick();
    const canvas = component.instance;
    const service = app.injector.get(ImageCanvasService);
    await until(
      () =>
        canvas.coldOpenDone &&
        canvas.lastRenderedXmp === canvas.serializeForRender(library.adjustmentFor(id)()),
      'initial frame',
    );
    if (canvas.gpuPresent.active() !== gpu)
      throw Error('Requested render path was not established');
    if (colorSpace && canvas.gpuPresent.colorSpace() !== colorSpace)
      throw Error('Requested canvas gamut was not established');
    const initialModel = structuredClone(library.adjustmentFor(id)());
    const drawCanvas = host.querySelector('canvas:not([data-gpu-live])') as HTMLCanvasElement;
    const liveCanvas = () =>
      (gpu ? host.querySelector('canvas[data-gpu-live]') : drawCanvas) as HTMLCanvasElement;
    const initialPixel = pixel(liveCanvas(), liveCanvas().width, liveCanvas().height);
    const flush = () => library.flushPendingXmpWrites();
    const readXML = async () =>
      backend === 'hosted'
        ? new TextDecoder().decode(await access.readFile(folder, 'photo.xmp'))
        : (await control<{ xml: string }>('/workflow-fixture/' + fixture.key + '?original=false'))
            .xml;
    library.updateAdjustment(id, { exposure: 1.25 });
    await until(
      () => canvas.lastRenderedXmp === canvas.serializeForRender(library.adjustmentFor(id)()),
      'edited frame',
    );
    await flush();
    const saved = await readXML();
    const editedPixel = pixel(liveCanvas(), liveCanvas().width, liveCanvas().height);
    let baselineSubmitted = false;
    const renderer = Reflect.get(canvas.comparison, 'renderer').bind(canvas.comparison);
    const observed = new WeakSet<object>();
    Reflect.set(canvas.comparison, 'renderer', () => {
      const pipeline = renderer() as typeof canvas.pipeline;
      if (!observed.has(pipeline)) {
        observed.add(pipeline);
        const exportImage = pipeline.exportImage.bind(pipeline);
        const decode = pipeline.decode.bind(pipeline);
        pipeline.exportImage = (...args: Parameters<typeof exportImage>) => {
          const result = exportImage(...args);
          baselineSubmitted = true;
          return result;
        };
        pipeline.decode = (...args: Parameters<typeof decode>) => {
          const result = decode(...args);
          baselineSubmitted = true;
          return result;
        };
      }
      return pipeline;
    });
    let preparingTickMs: number | null = null;
    let preparingAtTick = false;
    let preparingTicks = 0;
    service.beforeAfterSplitX.set(1);
    if (camera100mp && gpu) {
      console.log('100MP comparison admission', canvas.gpuPresent.colorSpace());
      await until(
        () => baselineSubmitted || canvas.comparison.error() !== null,
        'comparison admission',
      );
      if (canvas.comparison.error()) throw Error(canvas.comparison.error()!);
    }
    const comparisonXml = camera100mp && gpu ? await readXML() : null;
    if (camera100mp && gpu) {
      preparingAtTick = canvas.comparison.loading();
      const deadline = performance.now() + 60000;
      do {
        const start = performance.now();
        library.updateAdjustment(id, { exposure: preparingTicks % 2 === 0 ? 1.35 : 1.36 });
        const target = canvas.serializeForRender(library.adjustmentFor(id)());
        while (canvas.lastRenderedXmp !== target) {
          if (performance.now() > deadline) throw Error('Preparing comparison blocked a live tick');
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        preparingTickMs = Math.max(preparingTickMs ?? 0, performance.now() - start);
        preparingTicks++;
      } while (canvas.comparison.loading() && performance.now() < deadline);
      console.log('100MP preparation ticks', preparingTicks, 'maximum', preparingTickMs);
    }
    await until(
      () => canvas.comparison.bitmap() !== null || canvas.comparison.error() !== null,
      'before pixels',
    );
    if (canvas.comparison.error()) throw Error(canvas.comparison.error()!);
    const beforePixel = pixel(drawCanvas, drawCanvas.width, drawCanvas.height);
    const owned = canvas.comparison.bitmap()!;
    const comparisonDoesNotWriteXMP =
      (camera100mp && gpu ? comparisonXml : await readXML()) === saved;
    for (const exposure of [1.5, 1.75, 2]) {
      library.updateAdjustment(id, { exposure });
      await until(
        () => canvas.lastRenderedXmp === canvas.serializeForRender(library.adjustmentFor(id)()),
        'live tick during before',
      );
      if (canvas.comparison.bitmap() !== owned)
        throw Error('A slider tick re-rendered the baseline');
    }
    await flush();
    const lastSaved = await readXML();
    const unchangedDuringComparison =
      saved !== null && initialModel.exposure === 0.25 && owned === canvas.comparison.bitmap();
    service.beforeAfterSplitX.set(null);
    await until(() => drawCanvas.getContext('2d') !== null, 'leaving before');
    const afterExit = pixel(liveCanvas(), liveCanvas().width, liveCanvas().height);
    const exitDoesNotWriteXMP = (await readXML()) === lastSaved;
    const currentBeforeVariant = structuredClone(library.adjustmentFor(id)());
    const history = app.injector.get(EditorWorkflowHistoryService);
    const variants = app.injector.get(EditorWorkflowVariantsService);
    const source = history.capture(id, currentBeforeVariant)!;
    const command = await variants.prepareCreate(source, 'Comparison variant');
    await variants.create(command);
    const primaryBeforeVariant = await readXML();
    await variants.select(source, command.workflow.variantId);
    await until(
      () => canvas.lastRenderedXmp === canvas.serializeForRender(library.adjustmentFor(id)()),
      'selected variant frame',
    );
    library.updateAdjustment(id, { exposure: 0.5 });
    await until(
      () => canvas.lastRenderedXmp === canvas.serializeForRender(library.adjustmentFor(id)()),
      'variant edit',
    );
    service.beforeAfterSplitX.set(1);
    await until(
      () => canvas.comparison.bitmap() !== null || canvas.comparison.error() !== null,
      'variant baseline',
    );
    if (canvas.comparison.error()) throw Error(canvas.comparison.error()!);
    const variantBefore = pixel(drawCanvas, drawCanvas.width, drawCanvas.height);
    const selectedModel = structuredClone(library.adjustmentFor(id)());
    await flush();
    const variantSource = history.capture(id, selectedModel)!;
    await variants.select(variantSource, 'primary');
    const originalAfter =
      backend === 'hosted' ? await access.readFile(folder, 'photo.dng') : await readOriginal();
    return {
      gpu: canvas.gpuPresent.active(),
      colorSpace: canvas.gpuPresent.colorSpace(),
      preparingTickMs,
      preparingAtTick,
      preparingTicks,
      sourceHash,
      initialPixel,
      editedPixel,
      beforePixel,
      afterExit,
      variantBefore,
      actualDifferentPixels: delta(initialPixel, editedPixel) > 5,
      baselineMatchesOpening: delta(initialPixel, beforePixel) <= 3,
      variantMatchesOwnOpening: delta(afterExit, variantBefore) <= 3,
      currentModelUnchangedByCompare: selectedModel.exposure === 0.5,
      primaryUnchangedByVariant: (await readXML()) === primaryBeforeVariant,
      comparisonDoesNotWriteXMP,
      exitDoesNotWriteXMP,
      unchangedDuringComparison,
      originalUnchanged:
        originalAfter.length === bytes.length && originalAfter.every((v, i) => v === bytes[i]),
    };
  } finally {
    app.destroy();
    host.remove();
    await root.removeEntry(name, { recursive: true });
  }
}
