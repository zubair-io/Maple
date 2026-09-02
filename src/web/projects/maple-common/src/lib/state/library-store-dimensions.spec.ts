import { signal } from '@angular/core';
import { AssetDimensionBatcher } from './library-store-dimensions';
import { Asset, AssetId } from '../models/asset';

// Minimal Asset stub — the batcher only reads/writes id, width, height,
// aspectRatio.
function asset(id: AssetId): Asset {
  return {
    id,
    filename: `${id}.dng`,
    folderId: 'source',
    rating: 0,
    flag: 'unflagged',
    colorLabel: null,
    thumbnailGradient: '',
    aspectRatio: 1,
    width: 0,
    height: 0,
  };
}

describe('AssetDimensionBatcher (#2521)', () => {
  /** rAF callbacks parked by the batcher, so a test can flush a "frame" on
   * demand instead of waiting on a real one — same pattern as
   * tone-curve.component.spec.ts. */
  let frames: FrameRequestCallback[];
  let rafSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    frames = [];
    rafSpy = vi.fn((cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('requestAnimationFrame', rafSpy);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => vi.unstubAllGlobals());

  function flushFrame(): void {
    const pending = [...frames];
    frames = [];
    for (const cb of pending) cb(0);
  }

  it('coalesces N corrections into exactly one assets.update() call', () => {
    const assets = signal<Asset[]>([asset('a'), asset('b'), asset('c'), asset('d'), asset('e')]);
    const updateSpy = vi.spyOn(assets, 'update');
    const batcher = new AssetDimensionBatcher(assets);

    batcher.update('a', 100, 50);
    batcher.update('b', 200, 100);
    batcher.update('c', 300, 150);
    batcher.update('d', 400, 200);
    batcher.update('e', 500, 250);

    // Nothing applied yet — still batched behind the pending frame.
    expect(updateSpy).not.toHaveBeenCalled();
    expect(assets().find((a) => a.id === 'a')!.width).toBe(0);

    flushFrame();

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const byId = new Map(assets().map((a) => [a.id, a]));
    expect(byId.get('a')).toMatchObject({ width: 100, height: 50, aspectRatio: 2 });
    expect(byId.get('b')).toMatchObject({ width: 200, height: 100, aspectRatio: 2 });
    expect(byId.get('c')).toMatchObject({ width: 300, height: 150, aspectRatio: 2 });
    expect(byId.get('d')).toMatchObject({ width: 400, height: 200, aspectRatio: 2 });
    expect(byId.get('e')).toMatchObject({ width: 500, height: 250, aspectRatio: 2 });
  });

  it('schedules only one animation frame no matter how many corrections arrive before it fires', () => {
    const assets = signal<Asset[]>([asset('a')]);
    const batcher = new AssetDimensionBatcher(assets);

    batcher.update('a', 10, 10);
    batcher.update('a', 20, 20);
    batcher.update('a', 30, 30);

    expect(rafSpy).toHaveBeenCalledTimes(1);
  });

  it('last write wins when the same id is corrected more than once before the frame fires', () => {
    const assets = signal<Asset[]>([asset('a')]);
    const batcher = new AssetDimensionBatcher(assets);

    batcher.update('a', 10, 10);
    batcher.update('a', 999, 111);
    flushFrame();

    expect(assets()[0]).toMatchObject({ width: 999, height: 111 });
  });

  it('schedules a fresh frame for the next batch after a flush', () => {
    const assets = signal<Asset[]>([asset('a'), asset('b')]);
    const updateSpy = vi.spyOn(assets, 'update');
    const batcher = new AssetDimensionBatcher(assets);

    batcher.update('a', 10, 10);
    flushFrame();
    batcher.update('b', 20, 20);
    flushFrame();

    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(assets().map((a) => a.width)).toEqual([10, 20]);
  });

  it('leaves assets unrelated to any pending correction untouched', () => {
    const untouched = asset('untouched');
    const assets = signal<Asset[]>([asset('a'), untouched]);
    const batcher = new AssetDimensionBatcher(assets);

    batcher.update('a', 10, 10);
    flushFrame();

    // Same object identity — the batcher must not rebuild rows it isn't
    // correcting, only the whole array once per flush.
    expect(assets()[1]).toBe(untouched);
  });
});
