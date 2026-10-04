import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetId } from '../../models/asset';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import { LensCorrectionCapabilities } from '../../state/library-store-lens-corrections';
import { runRender2d, type Render2dHost } from './image-canvas.render2d';
import { ImageCanvasGpuPresent, type GpuPresentHost } from './image-canvas.gpu-present';

const ASSET = 'fit-failure' as AssetId;
afterEach(() => vi.restoreAllMocks());

for (const route of ['CPU', 'GPU'] as const) {
  describe(`${route} adjustment failure fit provenance`, () => {
    function harness() {
      const capabilities = new LensCorrectionCapabilities();
      capabilities.resetAutoFit(ASSET);
      const model = signal(defaultAdjustmentModel());
      let reject!: (error: Error) => void;
      const failed = new Promise<never>((_, fail) => (reject = fail));
      const host = {
        currentAssetId: ASSET as AssetId | null,
        renderGeneration: 1,
        state: {
          autoFitRevisionFor: (id: AssetId) => capabilities.autoFitRevisionFor(id),
          adjustmentFor: () => model,
          lensCorrectionsFor: (id: AssetId) => capabilities.for(id),
          seedLensProfile: (id: AssetId, profile: null, autoFit?: boolean, revision?: number) =>
            capabilities.seed(id, false, true, undefined, profile, autoFit, revision),
        },
        pipeline: { decode: () => failed, renderLiveSession: () => failed },
        filmSync: { cpuLutBytesForCurrent: () => undefined },
      };
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const run = () =>
        route === 'CPU'
          ? runRender2d(
              host as unknown as Render2dHost,
              '<xmp/>',
              1,
              { maxLongEdge: 512, qualityPreview: true },
              new Uint8Array([1]),
              'dng',
            )
          : new ImageCanvasGpuPresent(host as unknown as GpuPresentHost).render('<xmp/>', 1);
      return { capabilities, model, host, reject, run };
    }
    it('settles a current pending Auto render failure as unavailable', async () => {
      const h = harness();
      const pending = h.run();
      h.reject(new Error('actual rejected renderer request'));
      await pending;
      expect(h.capabilities.for(ASSET).autoFit).toBe(false);
    });
    for (const newer of ['revision', 'completed revision', 'generation', 'asset', 'Neutral']) {
      it(`does not publish an old failure after a newer ${newer}`, async () => {
        const h = harness();
        const pending = h.run();
        if (newer === 'revision' || newer === 'completed revision')
          h.capabilities.resetAutoFit(ASSET);
        if (newer === 'completed revision')
          h.capabilities.seed(
            ASSET,
            false,
            true,
            undefined,
            null,
            true,
            h.capabilities.autoFitRevisionFor(ASSET),
          );
        if (newer === 'generation') h.host.renderGeneration++;
        if (newer === 'asset') h.host.currentAssetId = 'another-photo' as AssetId;
        if (newer === 'Neutral') h.model.set({ ...h.model(), profile: 'Neutral' });
        h.reject(new Error('superseded renderer request'));
        await pending;
        expect(h.capabilities.for(ASSET).autoFit).toBe(
          newer === 'completed revision' ? true : undefined,
        );
      });
    }
    it('retains a known achieved fit when an ordinary scalar render fails', async () => {
      const h = harness();
      h.capabilities.seed(
        ASSET,
        false,
        true,
        undefined,
        null,
        true,
        h.capabilities.autoFitRevisionFor(ASSET),
      );
      const pending = h.run();
      h.reject(new Error('scalar render failed'));
      await pending;
      expect(h.capabilities.for(ASSET).autoFit).toBe(true);
    });
  });
}
