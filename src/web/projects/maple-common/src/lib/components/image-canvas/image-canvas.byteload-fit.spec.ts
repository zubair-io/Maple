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
    byteLoadGeneration: 0,
    imageBitmap: signal<ImageBitmap | null>(null),
    byteLoadError: signal(null),
    canvasSvc: { currentPixels: signal(null) },
    state: {
      bytesFor: (): Uint8Array | undefined => undefined,
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
  it('ignores an old retry failure while the new byte request still owns the asset', async () => {
    const h = harness();
    let rejectFirst!: (error: Error) => void;
    let rejectSecond!: (error: Error) => void;
    const first = new Promise<Uint8Array>((_done, fail) => {
      rejectFirst = fail;
    });
    const second = new Promise<Uint8Array>((_done, fail) => {
      rejectSecond = fail;
    });
    h.host.state.bytesForAsset = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    h.start();
    h.start();
    rejectFirst(new Error('obsolete transport failure'));
    await first.catch(() => undefined);
    await Promise.resolve();
    expect(h.host.byteLoadError()).toBeNull();
    expect(h.capabilities.for(ASSET).autoFit).toBeUndefined();
    rejectSecond(new Error('current transport failure'));
    await second.catch(() => undefined);
    await Promise.resolve();
    expect(h.host.byteLoadError()).not.toBeNull();
    expect(h.capabilities.for(ASSET).autoFit).toBe(false);
  });
  it('retries retained input without requesting nonexistent backend bytes', async () => {
    const h = harness();
    const source = new Uint8Array([4, 5, 6]);
    h.host.state.bytesFor = () => source;
    const fetch = vi.spyOn(h.host.state, 'bytesForAsset');
    h.start();
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
    expect(h.host.loadReal).toHaveBeenCalledWith(ASSET, 'missing.dng', source);
    expect(source).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('settles current Auto after Neutral then Auto during the same byte request', async () => {
    const h = harness();
    h.start();
    h.model.set({ ...h.model(), profile: 'Neutral' });
    h.capabilities.resetAutoFit(ASSET);
    h.model.set({ ...h.model(), profile: 'Auto' });
    h.capabilities.resetAutoFit(ASSET);
    await h.fail({ status: 404 });
    expect(h.capabilities.for(ASSET).autoFit).toBe(false);
  });

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
    'superseded request',
    'Neutral',
    'completed active',
    'completed unavailable',
  ])
    it(`preserves a newer ${newer} while the byte request fails`, async () => {
      const h = harness();
      h.start();
      if (newer === 'asset') h.host.currentAssetId = 'photos:next.dng';
      if (newer === 'superseded request') h.host.byteLoadGeneration++;
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
