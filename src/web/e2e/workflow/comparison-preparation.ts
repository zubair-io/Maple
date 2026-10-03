import type { ImageCanvasComponent } from '../../projects/maple-common/src/lib/components/image-canvas/image-canvas.component';
import type { LibraryStateService } from '../../projects/maple-common/src/lib/state/library-state.service';

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Observe real baseline requests, then tick throughout the 100MP preparation window. */
export async function measureComparisonPreparation(
  canvas: ImageCanvasComponent,
  library: LibraryStateService,
  id: string,
  readXML: () => Promise<string | null>,
) {
  let submitted = false;
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
        submitted = true;
        return result;
      };
      pipeline.decode = (...args: Parameters<typeof decode>) => {
        const result = decode(...args);
        submitted = true;
        return result;
      };
    }
    return pipeline;
  });
  try {
    canvas.canvasSvc.beforeAfterSplitX.set(1);
    console.log('100MP comparison admission', canvas.gpuPresent.colorSpace());
    const deadline = performance.now() + 60000;
    while (!submitted) {
      if (canvas.comparison.error()) throw Error(canvas.comparison.error()!);
      if (performance.now() > deadline) throw Error('Timed out: comparison admission');
      await frame();
    }
    // Read the real sidecar after comparison starts, before intentional edits.
    const xml = await readXML();
    const loadingAtFirstTick = canvas.comparison.loading();
    let maximumMs = 0;
    let samples = 0;
    do {
      const start = performance.now();
      library.updateAdjustment(id, { exposure: samples % 2 === 0 ? 1.35 : 1.36 });
      const target = canvas.serializeForRender(library.adjustmentFor(id)());
      while (canvas.lastRenderedXmp !== target) {
        if (performance.now() > deadline) throw Error('Preparing comparison blocked a live tick');
        await frame();
      }
      maximumMs = Math.max(maximumMs, performance.now() - start);
      samples++;
    } while (canvas.comparison.loading() && performance.now() < deadline);
    console.log('100MP preparation ticks', samples, 'maximum', maximumMs);
    return { xml, loadingAtFirstTick, maximumMs, samples };
  } finally {
    Reflect.deleteProperty(canvas.comparison, 'renderer');
  }
}
