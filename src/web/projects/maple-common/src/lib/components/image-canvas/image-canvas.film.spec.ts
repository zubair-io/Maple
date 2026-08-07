// ImageCanvasFilmSync — unit tests (epic #2683, Task 12).
//
// Exercises the standalone class against a minimal `FilmSyncHost` stub,
// same shape as `image-canvas.gpu-present.spec.ts`'s `makeHost` — no full
// `ImageCanvasComponent` mount needed. `syncIfNeeded` is a plain method
// (not a reactive `effect()`), so these tests call it directly, mirroring
// how the component's model-change effect calls it on every tick.

import { describe, it, expect, vi } from 'vitest';

import { ImageCanvasFilmSync, type FilmSyncHost } from './image-canvas.film';
import { filmLutKey } from '../../film/film-lut.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import type { AssetId } from '../../models/asset';

const ASSET_ID = 'asset-1' as AssetId;

function makeHost(overrides?: { getLattice?: (id: string) => Promise<ArrayBuffer | null> }) {
  // `model.filmLook` backs the `sync()`'s post-await staleness re-check
  // (`adjustmentFor(assetId)().filmLook !== lookId`) — a real caller always
  // updates the reactive model BEFORE calling `syncIfNeeded` with the new
  // look id, so `syncCall` below (the tests' entry point) mirrors that by
  // writing `model.filmLook` first.
  const model: AdjustmentModel = { ...defaultAdjustmentModel() };
  const setFilmLut = vi.fn(async (_bytes: ArrayBuffer, _key: number) => undefined);
  const getLattice =
    overrides?.getLattice ?? vi.fn(async (id: string) => new TextEncoder().encode(id).buffer);
  const onLutApplied = vi.fn();

  const host: FilmSyncHost = {
    state: {
      adjustmentFor: (_id: AssetId) => () => model,
    } as unknown as FilmSyncHost['state'],
    pipeline: { setFilmLut } as unknown as FilmSyncHost['pipeline'],
    filmLut: { getLattice } as unknown as FilmSyncHost['filmLut'],
    currentAssetId: ASSET_ID,
  };

  const sync = new ImageCanvasFilmSync(host, onLutApplied);
  const syncCall = (assetId: AssetId, lookId: string, gpuActive: boolean): void => {
    model.filmLook = lookId;
    sync.syncIfNeeded(assetId, lookId, gpuActive);
  };
  return { sync, syncCall, setFilmLut, getLattice, onLutApplied };
}

/** Await the async chain inside `sync()` (fetch → post → onLutApplied). */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ImageCanvasFilmSync.syncIfNeeded', () => {
  it('does nothing while the GPU live session is not active', async () => {
    const { syncCall, setFilmLut } = makeHost();
    syncCall(ASSET_ID, 'slide_fuji_velvia_50', false);
    await flush();

    expect(setFilmLut).not.toHaveBeenCalled();
  });

  it('posts set-film-lut with the fetched bytes and the FNV-1a key', async () => {
    const { syncCall, setFilmLut, getLattice, onLutApplied } = makeHost();
    syncCall(ASSET_ID, 'slide_fuji_velvia_50', true);
    await flush();

    expect(getLattice).toHaveBeenCalledWith('slide_fuji_velvia_50');
    expect(setFilmLut).toHaveBeenCalledTimes(1);
    const [bytes, key] = setFilmLut.mock.calls[0]!;
    expect(Array.from(new Uint8Array(bytes as ArrayBuffer))).toEqual(
      Array.from(new TextEncoder().encode('slide_fuji_velvia_50')),
    );
    expect(key).toBe(filmLutKey('slide_fuji_velvia_50'));
    expect(onLutApplied).toHaveBeenCalledTimes(1);
  });

  it('posts a zero-length buffer and key 0 for an empty (None) look id', async () => {
    const { syncCall, setFilmLut } = makeHost();
    syncCall(ASSET_ID, '', true);
    await flush();

    expect(setFilmLut).toHaveBeenCalledTimes(1);
    const [bytes, key] = setFilmLut.mock.calls[0]!;
    expect((bytes as ArrayBuffer).byteLength).toBe(0);
    expect(key).toBe(0);
  });

  it('does not re-post the same (assetId, lookId) pair twice in a row', async () => {
    const { syncCall, setFilmLut } = makeHost();
    syncCall(ASSET_ID, 'slide_fuji_velvia_50', true);
    await flush();
    setFilmLut.mockClear();

    syncCall(ASSET_ID, 'slide_fuji_velvia_50', true);
    await flush();

    expect(setFilmLut).not.toHaveBeenCalled();
  });

  it('re-posts when the look id changes for the same asset', async () => {
    const { syncCall, setFilmLut } = makeHost();
    syncCall(ASSET_ID, 'slide_fuji_velvia_50', true);
    await flush();
    setFilmLut.mockClear();

    syncCall(ASSET_ID, 'black_white_kodak_tri_x_400', true);
    await flush();

    expect(setFilmLut).toHaveBeenCalledTimes(1);
  });

  it('reset() clears the dedup so a fresh session re-posts a previously-seen (asset, look) pair', async () => {
    const { sync, syncCall, setFilmLut } = makeHost();
    syncCall(ASSET_ID, 'slide_fuji_velvia_50', true);
    await flush();
    setFilmLut.mockClear();

    sync.reset();
    syncCall(ASSET_ID, 'slide_fuji_velvia_50', true);
    await flush();

    expect(setFilmLut).toHaveBeenCalledTimes(1);
  });

  it('resolves a null lattice (404/network failure) as a clear, never throwing', async () => {
    const { syncCall, setFilmLut } = makeHost({ getLattice: async () => null });
    syncCall(ASSET_ID, 'retired_catalog_id', true);
    await flush();

    expect(setFilmLut).toHaveBeenCalledTimes(1);
    const [bytes] = setFilmLut.mock.calls[0]!;
    expect((bytes as ArrayBuffer).byteLength).toBe(0);
  });
});
