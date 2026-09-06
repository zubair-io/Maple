import { describe, it, expect, vi } from 'vitest';
import { ImageCanvasNativeDetail, type DetailBase } from './image-canvas.native-detail';
import { NativeDetailSupersededError } from '../../raw-pipeline/raw-pipeline.native-detail.types';
import type {
  NativeDetailArgs,
  NativeDetailPixels,
} from '../../raw-pipeline/raw-pipeline.native-detail.types';
import {
  containsDetailRect,
  expandDetailRect,
  visibleDetailRect,
  type DetailView,
} from './image-canvas.native-detail.geometry';

function setup() {
  const input = {
    assetId: 'one',
    bytes: new Uint8Array([1]),
    ext: 'dng',
    generation: 1,
    xmp: 'seeded',
  };
  const base: DetailBase = {
    assetId: 'one',
    generation: 1,
    displayXmp: 'seeded',
    sizing: { maxLongEdge: 800, qualityPreview: true },
  };
  let view: DetailView | null = {
    nativeW: 6000,
    nativeH: 4000,
    canvasW: 3000,
    canvasH: 2000,
    wrapW: 800,
    wrapH: 600,
    pan: { x: 0, y: 0 },
  };
  const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
  const pipeline = {
    closeNativeDetail: vi.fn(),
    renderNativeDetail: vi.fn(
      async (args: NativeDetailArgs): Promise<NativeDetailPixels> => ({
        width: args.rect.width,
        height: args.rect.height,
        rgb: new Uint8Array(args.rect.width * args.rect.height * 3),
      }),
    ),
  };
  const toBitmap = vi.fn(async () => bitmap);
  const detail = new ImageCanvasNativeDetail(
    { pipeline, currentInput: () => input, detailView: () => view },
    toBitmap,
  );
  detail.recordBase(base);
  return {
    input,
    base,
    pipeline,
    detail,
    bitmap,
    toBitmap,
    setView: (v: DetailView | null) => (view = v),
    view: () => view!,
  };
}

describe('native-detail geometry', () => {
  it('maps a DPR2 true-100% viewport into oriented native source coordinates', () => {
    const s = setup();
    expect(visibleDetailRect(s.view())).toEqual({ x: 2200, y: 1400, width: 1600, height: 1200 });
    expect(visibleDetailRect({ ...s.view(), pan: { x: 100, y: -50 } })).toEqual({
      x: 2000,
      y: 1500,
      width: 1600,
      height: 1200,
    });
  });
  it('clamps pan headroom at the source edge and rejects off-image/invalid views', () => {
    const s = setup();
    expect(expandDetailRect({ x: 0, y: 5, width: 800, height: 600 }, 6000, 4000)).toEqual({
      x: 0,
      y: 0,
      width: 900,
      height: 705,
    });
    expect(visibleDetailRect({ ...s.view(), pan: { x: 10000, y: 0 } })).toBeNull();
    expect(visibleDetailRect({ ...s.view(), canvasW: 0 })).toBeNull();
    expect(
      containsDetailRect({ x: 1, y: 1, width: 3, height: 3 }, { x: 1, y: 1, width: 3, height: 3 }),
    ).toBe(true);
  });
});

describe('one native-detail overlay', () => {
  it('allows later pans after an earlier queued request was superseded', async () => {
    const s = setup();
    let reject!: (error: Error) => void;
    s.pipeline.renderNativeDetail.mockImplementationOnce(
      () => new Promise((_, fail) => (reject = fail)),
    );
    const first = s.detail.render('seeded', 1);
    s.setView({ ...s.view(), pan: { x: 600, y: 0 } });
    reject(new NativeDetailSupersededError());
    await first;
    expect(await s.detail.render('seeded', 1)).toBe(true);
    expect(s.pipeline.renderNativeDetail).toHaveBeenCalledTimes(2);
    expect(s.detail.overlay()).not.toBeNull();
    s.setView({ ...s.view(), pan: { x: 0, y: 0 } });
    expect(await s.detail.render('seeded', 1)).toBe(true);
    expect(s.pipeline.renderNativeDetail).toHaveBeenCalledTimes(3);
  });
  it('uses the completed cold base anchors and reuses its patch within pan headroom', async () => {
    const s = setup();
    expect(await s.detail.render('seeded', 1)).toBe(true);
    expect(s.pipeline.renderNativeDetail).toHaveBeenCalledWith(
      expect.objectContaining({ xmp: undefined, maxLongEdge: 800, qualityPreview: true }),
    );
    s.setView({ ...s.view(), pan: { x: 20, y: 0 } });
    expect(await s.detail.render('seeded', 1)).toBe(true);
    expect(s.pipeline.renderNativeDetail).toHaveBeenCalledTimes(1);
    s.detail.reset();
    expect(s.bitmap.close).toHaveBeenCalledOnce();
    expect(s.pipeline.closeNativeDetail).toHaveBeenCalledOnce();
    expect(s.detail.overlay()).toBeNull();
  });
  it('does not publish after asset/model invalidation while WASM is in flight', async () => {
    const s = setup();
    let resolve!: (p: { width: number; height: number; rgb: Uint8Array }) => void;
    s.pipeline.renderNativeDetail.mockImplementation(() => new Promise((r) => (resolve = r)));
    const pending = s.detail.render('seeded', 1);
    s.detail.reset();
    s.input.assetId = 'two';
    resolve({ width: 1, height: 1, rgb: new Uint8Array(3) });
    await pending;
    expect(s.toBitmap).not.toHaveBeenCalled();
    expect(s.detail.overlay()).toBeNull();
  });
  it('closes a late bitmap if the view pans outside its source rect', async () => {
    const s = setup();
    s.toBitmap.mockImplementation(async () => {
      s.setView({ ...s.view(), pan: { x: 1000, y: 0 } });
      return s.bitmap;
    });
    await s.detail.render('seeded', 1);
    expect(s.bitmap.close).toHaveBeenCalledOnce();
    expect(s.detail.overlay()).toBeNull();
  });
  it('falls back for an ineligible view, mismatched base, unsupported stage, or memory cap', async () => {
    const s = setup();
    expect(await s.detail.render('edited', 2)).toBe(false);
    s.setView(null);
    expect(await s.detail.render('seeded', 1)).toBe(false);
    s.setView({
      nativeW: 6000,
      nativeH: 4000,
      canvasW: 6000,
      canvasH: 4000,
      wrapW: 6000,
      wrapH: 4000,
      pan: { x: 0, y: 0 },
    });
    expect(await s.detail.render('seeded', 1)).toBe(false);
    expect(s.pipeline.renderNativeDetail).not.toHaveBeenCalled();
    s.setView({ ...s.view(), wrapW: 800, wrapH: 600 });
    s.pipeline.renderNativeDetail.mockRejectedValue(new Error('dehaze'));
    expect(await s.detail.render('seeded', 1)).toBe(false);
    expect(await s.detail.render('seeded', 1)).toBe(false);
    expect(s.pipeline.renderNativeDetail).toHaveBeenCalledOnce();
  });
  it('keeps the exact resolved film bytes of the completed base', async () => {
    const s = setup();
    const filmLut = new ArrayBuffer(3);
    s.detail.recordBase({ ...s.base, renderXmp: 'seeded', filmLut });
    await s.detail.render('seeded', 1);
    expect(s.pipeline.renderNativeDetail.mock.calls[0][0]).toMatchObject({
      xmp: 'seeded',
      filmLut,
    });
    s.setView(null);
    expect(s.detail.visibleOverlay()).toBeNull();
  });
});
