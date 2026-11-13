import { effect, untracked } from '@angular/core';
import type { Injector } from '@angular/core';
import { coldOpen2d } from './image-canvas.render2d';
import type {
  GpuKillSwitchHost,
  GpuPresentHost,
  ImageCanvasGpuPresent,
} from './image-canvas.gpu-present';

/** Tear down a wedged live session and reopen its retained image through 2D. */
export function wireGpuKillSwitchEffect(
  host: GpuKillSwitchHost,
  gpuPresent: ImageCanvasGpuPresent,
  injector: Injector,
): () => void {
  const ref = effect(
    () => {
      const killSwitchOff = !gpuPresent.enabled;
      if (!killSwitchOff || !gpuPresent.active()) return;
      untracked(() => {
        gpuPresent.teardown();
        const assetId = host.currentAssetId;
        const asset = host.state.focusedAsset();
        if (!assetId || !asset || asset.id !== assetId || !host.currentBytes) return;
        void coldOpen2d(host, assetId, asset.filename, host.currentExt, host.currentBytes);
      });
    },
    { injector },
  );
  return () => ref.destroy();
}

/** Publish asynchronous worker scope samples without delaying render replies. */
export function wireScopeSampleEffect(host: GpuPresentHost, injector: Injector): () => void {
  const ref = effect(
    () => {
      const sample = host.pipeline.scopeSample();
      if (sample) host.canvasSvc.currentPixels.set(sample);
    },
    { injector },
  );
  return () => ref.destroy();
}
