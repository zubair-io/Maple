import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeDetailRequest } from './raw-pipeline.native-detail.types';

import { NativeDetailWorker } from './raw-pipeline.native-detail-handler';

describe('worker native-detail handle lifetime', () => {
  const postMessage = vi.fn();
  const fake = {
    open: vi.fn(),
    free: vi.fn(),
    tile: vi.fn(),
    patchFree: vi.fn(),
    ready: vi.fn(async (): Promise<unknown> => ({})),
  };
  let worker: NativeDetailWorker;
  const handleNativeDetail = (req: NativeDetailRequest) => worker.render(req);
  const closeNativeDetail = () => worker?.close();
  const request = (): NativeDetailRequest => ({
    id: 1,
    type: 'native-detail',
    sourceId: 'one',
    ext: 'dng',
    bytes: new Uint8Array([1, 2]).buffer,
    rect: { x: 3, y: 4, width: 5, height: 6 },
    maxLongEdge: 800,
    qualityPreview: true,
  });

  beforeEach(() => {
    closeNativeDetail();
    vi.clearAllMocks();
    worker = new NativeDetailWorker({
      ready: fake.ready,
      post: postMessage,
      open: (bytes, ext) => {
        fake.open(bytes, ext);
        return { free: fake.free, render_tile: fake.tile };
      },
    });
    fake.tile.mockImplementation(() => ({
      width: 5,
      height: 6,
      take_rgb: () => new Uint8Array(90),
      free: fake.patchFree,
    }));
  });
  afterEach(() => {
    closeNativeDetail();
    vi.unstubAllGlobals();
  });

  it('retains one mosaic over pans and frees the old one before opening another asset', async () => {
    await handleNativeDetail(request());
    await handleNativeDetail({ ...request(), id: 2, bytes: undefined });
    expect(fake.open).toHaveBeenCalledOnce();
    expect(fake.patchFree).toHaveBeenCalledTimes(2);
    expect(fake.tile).toHaveBeenCalledWith(
      undefined,
      new Uint32Array([3, 4, 5, 6]),
      800,
      true,
      new Uint8Array(),
    );
    await handleNativeDetail({ ...request(), sourceId: 'two', id: 3 });
    expect(fake.free).toHaveBeenCalledOnce();
    expect(fake.free.mock.invocationCallOrder[0]).toBeLessThan(
      fake.open.mock.invocationCallOrder[1],
    );
    expect(postMessage.mock.lastCall?.[0]).toMatchObject({
      type: 'native-detail-success',
      width: 5,
      height: 6,
    });
  });

  it('frees the patch even if transferring its pixels fails', async () => {
    postMessage.mockImplementationOnce(() => {
      throw new Error('transfer failed');
    });
    await handleNativeDetail(request());
    expect(fake.patchFree).toHaveBeenCalledOnce();
    expect(postMessage.mock.lastCall?.[0]).toMatchObject({
      type: 'native-detail-error',
      message: 'transfer failed',
    });
  });

  it('does not reopen after close while initialization is still pending', async () => {
    let ready!: (value: unknown) => void;
    fake.ready.mockImplementationOnce(() => new Promise((resolve) => (ready = resolve)));
    const pending = handleNativeDetail(request());
    closeNativeDetail();
    ready({});
    await pending;
    expect(fake.open).not.toHaveBeenCalled();
    expect(postMessage.mock.lastCall?.[0]).toMatchObject({
      type: 'native-detail-error',
      message: expect.stringContaining('superseded'),
    });
  });
});
