import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import { LensCorrectionCapabilities } from '../../state/library-store-lens-corrections';
import type { Render2dHost } from './image-canvas.render2d';
import { ImageCanvasRawOpen } from './image-canvas.raw-open';

const ASSET = 'photo.x3f';
afterEach(() => vi.restoreAllMocks());

function applyTransition(
  outcome: string,
  model: {
    (): ReturnType<typeof defaultAdjustmentModel>;
    set(value: ReturnType<typeof defaultAdjustmentModel>): void;
  },
  capabilities: LensCorrectionCapabilities,
  host: { currentAssetId: string | null },
  rawOpen: ImageCanvasRawOpen,
): void {
  if (outcome === 'asset') host.currentAssetId = 'another.x3f';
  if (outcome === 'reset') rawOpen.reset();
  if (outcome === 'Neutral') model.set({ ...model(), profile: 'Neutral' });
  if (outcome === 'profile transition') {
    model.set({ ...model(), profile: 'Neutral' });
    capabilities.resetAutoFit(ASSET);
    model.set({ ...model(), profile: 'Auto' });
    capabilities.resetAutoFit(ASSET);
  }
  if (outcome.startsWith('completed'))
    capabilities.seedProfile(
      ASSET,
      null,
      outcome === 'completed active',
      capabilities.autoFitRevisionFor(ASSET),
    );
}

describe('actual X3F normalization failure provenance', () => {
  for (const outcome of [
    'pending',
    'profile transition',
    'completed active',
    'completed unavailable',
    'asset',
    'reset',
    'Neutral',
  ])
    it(`settles only the owned current pending outcome: ${outcome}`, async () => {
      const capabilities = new LensCorrectionCapabilities();
      capabilities.resetAutoFit(ASSET);
      const model = signal(defaultAdjustmentModel());
      let reject!: (error: Error) => void;
      const preview = new Promise<never>((_done, fail) => {
        reject = fail;
      });
      const host = {
        currentAssetId: ASSET as string | null,
        renderGeneration: 1,
        state: {
          adjustmentFor: () => model,
          autoFitRevisionFor: capabilities.autoFitRevisionFor.bind(capabilities),
          lensCorrectionsFor: capabilities.for.bind(capabilities),
          seedLensProfile: capabilities.seedProfile.bind(capabilities),
        },
        pipeline: { decode: vi.fn() },
      };
      const setCurrentInput = vi.fn();
      const byteLoadError = signal(null);
      const rawOpen = new ImageCanvasRawOpen(host as unknown as Render2dHost, {
        byteLoadError,
        embeddedPreview: { extractEmbeddedPreview: () => preview },
        imageBitmap: signal<ImageBitmap | null>(null),
        currentAssetId: () => host.currentAssetId,
        coldOpenDone: () => false,
        gpuEnabled: () => false,
        openGpu: vi.fn(),
        setCurrentInput,
        recordPaintedDims: vi.fn(),
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const source = new Uint8Array([1, 2, 3]);
      const original = source.slice();
      const opening = rawOpen.load(ASSET, 'photo.x3f', source);
      const completion = opening.then(
        () => 'resolved',
        () => 'rejected',
      );
      applyTransition(outcome, model, capabilities, host, rawOpen);
      reject(new Error('actual embedded preview cannot be extracted'));
      expect(await completion).toBe('resolved');
      expect(capabilities.for(ASSET).autoFit).toBe(
        outcome === 'pending' ||
          outcome === 'profile transition' ||
          outcome === 'completed unavailable'
          ? false
          : outcome === 'completed active'
            ? true
            : undefined,
      );
      expect(byteLoadError() !== null).toBe(outcome !== 'asset' && outcome !== 'reset');
      expect(setCurrentInput).not.toHaveBeenCalled();
      expect(host.pipeline.decode).not.toHaveBeenCalled();
      expect(source).toEqual(original);
    });
});
