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
  // Always a real `vi.fn` (even when a test supplies its own resolver via
  // `overrides.getLattice`) so every test can uniformly assert on/clear its
  // call history, not just the ones using the default resolver.
  const getLattice = vi.fn(
    overrides?.getLattice ?? (async (id: string) => new TextEncoder().encode(id).buffer),
  );
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
  return { sync, syncCall, setFilmLut, getLattice, onLutApplied, model, host };
}

/** Await the async chain inside `sync()`/`resolveCpuLut()` (fetch → post →
 *  onLutApplied) to completion. A macrotask boundary rather than a fixed
 *  microtask-tick count: the CPU-path tests' chain depth differs slightly
 *  from the GPU path's, and counting exact ticks is exactly the kind of
 *  fragile timing assumption that breaks the moment either chain grows an
 *  await. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

// #3171 — the WASM-CPU 2D fast/refine path's sibling to `syncIfNeeded`/`sync`
// above: `ensureCpuLutResolving` kicks off (and dedups) the fetch,
// `cpuLutBytesFor`/`cpuLutBytesForCurrent` read whatever's already cached,
// synchronously, with no fetch of their own.
describe('ImageCanvasFilmSync — CPU 2D-path LUT cache', () => {
  it('cpuLutBytesFor returns undefined before anything has resolved', () => {
    const { sync } = makeHost();
    expect(sync.cpuLutBytesFor(ASSET_ID, 'slide_fuji_velvia_50')).toBeUndefined();
  });

  it('resolves and caches the bytes, and never touches the GPU pipeline.setFilmLut', async () => {
    const { sync, getLattice, setFilmLut, onLutApplied, model } = makeHost();
    model.filmLook = 'slide_fuji_velvia_50';
    sync.ensureCpuLutResolving(ASSET_ID, 'slide_fuji_velvia_50');
    await flush();

    expect(getLattice).toHaveBeenCalledWith('slide_fuji_velvia_50');
    const bytes = sync.cpuLutBytesFor(ASSET_ID, 'slide_fuji_velvia_50');
    expect(bytes).toBeDefined();
    expect(Array.from(new Uint8Array(bytes!))).toEqual(
      Array.from(new TextEncoder().encode('slide_fuji_velvia_50')),
    );
    expect(onLutApplied).toHaveBeenCalledTimes(1);
    expect(setFilmLut).not.toHaveBeenCalled(); // CPU path never posts to the GPU session
  });

  it('cpuLutBytesForCurrent reads off host.currentAssetId + the current model', async () => {
    const { sync, model } = makeHost();
    model.filmLook = 'black_white_kodak_tri_x_400';
    sync.ensureCpuLutResolving(ASSET_ID, 'black_white_kodak_tri_x_400');
    await flush();

    const bytes = sync.cpuLutBytesForCurrent();
    expect(bytes).toBeDefined();
    expect(Array.from(new Uint8Array(bytes!))).toEqual(
      Array.from(new TextEncoder().encode('black_white_kodak_tri_x_400')),
    );
  });

  it('does not re-fetch for the same (assetId, lookId) pair', async () => {
    const { sync, getLattice, model } = makeHost();
    model.filmLook = 'slide_fuji_velvia_50';
    sync.ensureCpuLutResolving(ASSET_ID, 'slide_fuji_velvia_50');
    await flush();
    getLattice.mockClear();

    sync.ensureCpuLutResolving(ASSET_ID, 'slide_fuji_velvia_50');
    await flush();

    expect(getLattice).not.toHaveBeenCalled();
  });

  it('does not start a second fetch for the same pair while the first is still in flight', () => {
    const { sync, getLattice, model } = makeHost();
    model.filmLook = 'slide_fuji_velvia_50';
    sync.ensureCpuLutResolving(ASSET_ID, 'slide_fuji_velvia_50');
    sync.ensureCpuLutResolving(ASSET_ID, 'slide_fuji_velvia_50');

    expect(getLattice).toHaveBeenCalledTimes(1);
  });

  it('re-fetches when the look id changes for the same asset', async () => {
    const { sync, getLattice, model } = makeHost();
    model.filmLook = 'slide_fuji_velvia_50';
    sync.ensureCpuLutResolving(ASSET_ID, 'slide_fuji_velvia_50');
    await flush();
    getLattice.mockClear();

    model.filmLook = 'black_white_kodak_tri_x_400';
    sync.ensureCpuLutResolving(ASSET_ID, 'black_white_kodak_tri_x_400');
    await flush();

    expect(getLattice).toHaveBeenCalledWith('black_white_kodak_tri_x_400');
    expect(sync.cpuLutBytesFor(ASSET_ID, 'slide_fuji_velvia_50')).toBeUndefined();
  });

  it('an empty (None) look id clears the cache synchronously, with no fetch', () => {
    const { sync, getLattice } = makeHost();
    sync.ensureCpuLutResolving(ASSET_ID, '');
    expect(getLattice).not.toHaveBeenCalled();
    expect(sync.cpuLutBytesFor(ASSET_ID, '')).toBeUndefined();
  });

  it('caches a null lattice (404/network failure) as "no look" without retrying every call', async () => {
    const { sync, getLattice, model } = makeHost({ getLattice: async () => null });
    model.filmLook = 'retired_catalog_id';
    sync.ensureCpuLutResolving(ASSET_ID, 'retired_catalog_id');
    await flush();

    expect(sync.cpuLutBytesFor(ASSET_ID, 'retired_catalog_id')).toBeUndefined();
    getLattice.mockClear();
    sync.ensureCpuLutResolving(ASSET_ID, 'retired_catalog_id');
    expect(getLattice).not.toHaveBeenCalled();
  });

  it('drops a resolved fetch when the asset switched while it was pending', async () => {
    const { sync, host } = makeHost();
    sync.ensureCpuLutResolving(ASSET_ID, 'slide_fuji_velvia_50');
    (host as { currentAssetId: AssetId | null }).currentAssetId = 'asset-2' as AssetId;
    await flush();

    expect(sync.cpuLutBytesFor(ASSET_ID, 'slide_fuji_velvia_50')).toBeUndefined();
  });

  it('drops a resolved fetch when the look changed again while it was pending', async () => {
    const { sync, model } = makeHost();
    model.filmLook = 'slide_fuji_velvia_50';
    sync.ensureCpuLutResolving(ASSET_ID, 'slide_fuji_velvia_50');
    model.filmLook = 'black_white_kodak_tri_x_400'; // a second tick moved the look before the fetch settled
    await flush();

    expect(sync.cpuLutBytesFor(ASSET_ID, 'slide_fuji_velvia_50')).toBeUndefined();
  });

  it('reset() clears the CPU cache so a fresh session re-fetches a previously-seen pair', async () => {
    const { sync, getLattice, model } = makeHost();
    model.filmLook = 'slide_fuji_velvia_50';
    sync.ensureCpuLutResolving(ASSET_ID, 'slide_fuji_velvia_50');
    await flush();
    getLattice.mockClear();

    sync.reset();
    expect(sync.cpuLutBytesFor(ASSET_ID, 'slide_fuji_velvia_50')).toBeUndefined();
    sync.ensureCpuLutResolving(ASSET_ID, 'slide_fuji_velvia_50');
    await flush();

    expect(getLattice).toHaveBeenCalledTimes(1);
  });
});
