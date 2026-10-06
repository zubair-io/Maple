import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetId } from '../../models/asset';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import { LensCorrectionCapabilities } from '../../state/library-store-lens-corrections';
import { coldOpen2d, runRender2d, type Render2dHost } from './image-canvas.render2d';
import { ImageCanvasGpuPresent, type GpuPresentHost } from './image-canvas.gpu-present';

const ASSET = 'fit-failure' as AssetId;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const route of ['CPU', 'GPU', 'cold CPU'] as const) {
  describe(`${route} adjustment failure fit provenance`, () => {
    function harness() {
      const capabilities = new LensCorrectionCapabilities();
      capabilities.resetAutoFit(ASSET);
      const model = signal(defaultAdjustmentModel());
      let reject!: (error: Error) => void;
      let resolve!: (decoded: unknown) => void;
      const failed = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const host = {
        currentAssetId: ASSET as AssetId | null,
        renderGeneration: 1,
        loading: signal(false),
        imageBitmap: signal<ImageBitmap | null>(null),
        canvasSvc: { currentPixels: signal(null) },
        lastRenderedXmp: null,
        fastTargetPx: () => 512,
        serializeForRender: () => '<xmp/>',
        captureRenderSerializer: () => () => '<xmp/>',
        hasProvisionalPreview: () => false,
        recordNativeDims: vi.fn(),
        markColdOpenDone: vi.fn(),
        state: {
          updateAssetDimensions: vi.fn(),
          seedAsShotWhiteBalance: vi.fn(),
          seedLensCorrections: (
            id: AssetId,
            has: boolean,
            ca: boolean,
            camera: undefined,
            profile: null,
            autoFit?: boolean,
            revision?: number,
          ) => capabilities.seed(id, has, ca, camera, profile, autoFit, revision),
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
        route === 'cold CPU'
          ? coldOpen2d(
              host as unknown as Render2dHost,
              ASSET,
              'photo.dng',
              'dng',
              new Uint8Array([1]),
            )
          : route === 'CPU'
            ? runRender2d(
                host as unknown as Render2dHost,
                '<xmp/>',
                1,
                { maxLongEdge: 512, qualityPreview: true },
                new Uint8Array([1]),
                'dng',
              )
            : new ImageCanvasGpuPresent(host as unknown as GpuPresentHost).render('<xmp/>', 1);
      return { capabilities, model, host, reject, resolve, run };
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
    for (const achieved of [true, false]) {
      it(`retains a completed same-revision outcome ${achieved} arriving during failure`, async () => {
        const h = harness();
        const pending = h.run();
        h.capabilities.seed(
          ASSET,
          false,
          true,
          undefined,
          null,
          achieved,
          h.capabilities.autoFitRevisionFor(ASSET),
        );
        h.reject(new Error('request failed after actual fit outcome published'));
        await pending;
        expect(h.capabilities.for(ASSET).autoFit).toBe(achieved);
      });
    }
    if (route === 'cold CPU')
      it('does not publish an unpainted decoded Auto fit when bitmap creation rejects', async () => {
        const h = harness();
        vi.stubGlobal(
          'ImageData',
          class {
            constructor(
              readonly data: Uint8ClampedArray,
              readonly width: number,
              readonly height: number,
            ) {}
          },
        );
        vi.stubGlobal(
          'createImageBitmap',
          vi.fn().mockRejectedValue(new Error('bitmap creation failed')),
        );
        const pending = h.run();
        h.resolve({ width: 1, height: 1, rgb: new Uint8Array([40, 60, 80]), autoFit: true });
        await pending;
        expect(h.host.markColdOpenDone).not.toHaveBeenCalled();
        expect(globalThis.createImageBitmap).toHaveBeenCalledOnce();
        expect(h.capabilities.for(ASSET).autoFit).toBe(false);
        expect(h.host.imageBitmap()).toBeNull();
        expect(h.host.loading()).toBe(false);
      });
    it('retains a known achieved fit when a subsequent render fails', async () => {
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
