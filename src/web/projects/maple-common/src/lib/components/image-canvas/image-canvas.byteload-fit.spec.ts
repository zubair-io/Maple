import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import { LensCorrectionCapabilities } from '../../state/library-store-lens-corrections';
import { fetchAndLoadBytes, type ByteLoadHost } from './image-canvas.byteload';

const ASSET = 'photos:missing.dng';
afterEach(() => vi.restoreAllMocks());

function harness() {
  const capabilities = new LensCorrectionCapabilities();
  capabilities.resetAutoFit(ASSET);
  const model = signal(defaultAdjustmentModel());
  let reject!: (error: unknown) => void;
  const bytes = new Promise<Uint8Array>((_resolve, fail) => {
    reject = fail;
  });
  const host = {
    currentAssetId: ASSET as string | null,
    renderGeneration: 1,
    imageBitmap: signal<ImageBitmap | null>(null),
    byteLoadError: signal(null),
    canvasSvc: { currentPixels: signal(null) },
    state: {
      bytesForAsset: () => bytes,
      adjustmentFor: () => model,
      autoFitRevisionFor: capabilities.autoFitRevisionFor.bind(capabilities),
      lensCorrectionsFor: capabilities.for.bind(capabilities),
      seedLensProfile: capabilities.seedProfile.bind(capabilities),
    },
    loadReal: vi.fn(),
  };
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const start = () => fetchAndLoadBytes(host as unknown as ByteLoadHost, ASSET, 'missing.dng');
  const fail = async (error: unknown) => {
    reject(error);
    await bytes.catch(() => undefined);
    await Promise.resolve();
  };
  return { host, capabilities, model, start, fail };
}

describe('terminal byte-load Auto provenance', () => {
  for (const status of [403, 404, 0])
    it(`settles pending Auto when byte loading fails with status ${status}`, async () => {
      const h = harness();
      h.start();
      await h.fail({ status });
      expect(h.capabilities.for(ASSET).autoFit).toBe(false);
      expect(h.host.loadReal).not.toHaveBeenCalled();
      expect(h.host.byteLoadError()).not.toBeNull();
    });
  for (const newer of [
    'asset',
    'generation',
    'revision',
    'Neutral',
    'completed active',
    'completed unavailable',
  ])
    it(`preserves a newer ${newer} while the byte request fails`, async () => {
      const h = harness();
      h.start();
      if (newer === 'asset') h.host.currentAssetId = 'photos:next.dng';
      if (newer === 'generation') h.host.renderGeneration++;
      if (newer === 'revision') h.capabilities.resetAutoFit(ASSET);
      if (newer === 'Neutral') h.model.set({ ...h.model(), profile: 'Neutral' });
      if (newer.startsWith('completed'))
        h.capabilities.seedProfile(
          ASSET,
          null,
          newer === 'completed active',
          h.capabilities.autoFitRevisionFor(ASSET),
        );
      await h.fail(new Error('terminal failure'));
      expect(h.capabilities.for(ASSET).autoFit).toBe(
        newer === 'completed active' ? true : newer === 'completed unavailable' ? false : undefined,
      );
    });
});
