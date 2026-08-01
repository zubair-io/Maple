import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AssetId } from '../models/asset';
import { decodeHostedThumb } from './library-cache.hosted-thumb';

class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

const BITMAP = { width: 8, height: 6, close: vi.fn() } as unknown as ImageBitmap;
const ID = 'folder:photo' as AssetId;

function deps() {
  return {
    preview: { resolve: vi.fn(async (): Promise<Blob | null> => null) },
    pipeline: {
      decode: vi.fn(async () => ({
        width: 1,
        height: 1,
        rgb: new Uint8Array([1, 2, 3]),
        asShotTemperature: 6500,
        asShotTint: 0,
      })),
    },
    getBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    getSourceIdentity: vi.fn(async () => ({ size: 3, lastModified: 1 })),
    getSourceSnapshot: vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      source: { size: 3, lastModified: 1 },
    })),
  };
}

describe('decodeHostedThumb', () => {
  beforeEach(() => {
    vi.stubGlobal('ImageData', FakeImageData);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => BITMAP),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('uses the embedded preview for RAW cache misses', async () => {
    const d = deps();
    d.preview.resolve = vi.fn(async () => new Blob([new Uint8Array([4])]));
    const asset = { id: ID, filename: 'photo.X3F' } as Asset;

    await expect(decodeHostedThumb(asset, d)).resolves.toBe(BITMAP);
    expect(d.preview.resolve).toHaveBeenCalledWith(
      ID,
      d.getBytes,
      d.getSourceIdentity,
      d.getSourceSnapshot,
    );
    expect(d.pipeline.decode).not.toHaveBeenCalled();
  });

  it('decodes display-ready files through the existing pipeline path', async () => {
    const d = deps();
    const asset = { id: ID, filename: 'photo.JPG' } as Asset;

    await expect(decodeHostedThumb(asset, d)).resolves.toBe(BITMAP);
    expect(d.pipeline.decode).toHaveBeenCalledWith(expect.any(Uint8Array), 'jpg');
    expect(d.preview.resolve).not.toHaveBeenCalled();
  });

  it('falls back to sensor decode when a supported RAW has no embedded preview', async () => {
    const d = deps();
    const asset = { id: ID, filename: 'photo.RAF' } as Asset;

    await expect(decodeHostedThumb(asset, d)).resolves.toBe(BITMAP);
    expect(d.preview.resolve).toHaveBeenCalledOnce();
    expect(d.pipeline.decode).toHaveBeenCalledWith(expect.any(Uint8Array), 'raf');
  });

  it('keeps X3F as a graceful miss when its embedded preview is unavailable', async () => {
    const d = deps();
    const asset = { id: ID, filename: 'photo.X3F' } as Asset;

    await expect(decodeHostedThumb(asset, d)).resolves.toBeNull();
    expect(d.preview.resolve).toHaveBeenCalledOnce();
    expect(d.pipeline.decode).not.toHaveBeenCalled();
  });

  it('keeps the gradient fallback when source bytes are unavailable', async () => {
    const d = deps();
    d.getBytes.mockRejectedValue(new Error('permission lost'));
    const asset = { id: ID, filename: 'photo.JPG' } as Asset;

    await expect(decodeHostedThumb(asset, d)).resolves.toBeNull();
    expect(d.pipeline.decode).not.toHaveBeenCalled();
  });
});
