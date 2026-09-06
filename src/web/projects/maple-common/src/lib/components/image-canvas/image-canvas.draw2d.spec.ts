// drawCanvas2d — gradient-placeholder image cache (PR #1124 review).
//
// `drawCanvas2d` runs on every pan/zoom/split tick; the gradient placeholder
// must NOT construct a fresh `Image()` per tick. Covers:
//   - one Image per URL — the second draw reuses the cache, synchronously
//   - draws issued while the image is still loading coalesce to one repaint
//   - a stale load (URL switched, or real pixels arrived) never paints over
//     a newer frame
//   - a failed load falls back to the procedural gradient permanently
//
// The module-level cache is keyed by URL and persists across tests, so every
// test uses a unique URL. jsdom's `getContext('2d')` is null, so the 2D
// context and canvas are hand-rolled fakes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { drawCanvas2d, type Draw2dInputs } from './image-canvas.draw2d';

/** Stand-in for `Image` that records instances and fires loads on demand.
 *  `onload` (assigned at construction, before any per-frame listener) fires
 *  first, matching DOM registration-order semantics. */
class FakeImage {
  static instances: FakeImage[] = [];
  src = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private loadListeners: Array<() => void> = [];

  constructor() {
    FakeImage.instances.push(this);
  }

  addEventListener(type: string, cb: () => void, _opts?: { once?: boolean }): void {
    if (type === 'load') this.loadListeners.push(cb);
  }

  fireLoad(): void {
    this.onload?.();
    for (const cb of this.loadListeners.splice(0)) cb();
  }

  fireError(): void {
    this.onerror?.();
  }
}

interface FakeCtx {
  clearRect: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  rect: ReturnType<typeof vi.fn>;
  clip: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  createLinearGradient: ReturnType<typeof vi.fn>;
  fillStyle: string;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
}

function fakeCtx(): FakeCtx {
  return {
    clearRect: vi.fn(),
    save: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    restore: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillStyle: '',
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
  };
}

describe('native-detail canvas composition', () => {
  it('places the patch in the same source transform as the base at DPR2', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const ctx = fakeCtx();
    const canvas = fakeCanvas(ctx);
    const base = {} as ImageBitmap;
    const detail = {} as ImageBitmap;
    drawCanvas2d(canvas, {
      wrapW: 800,
      wrapH: 600,
      canvasW: 3000,
      canvasH: 2000,
      pan: { x: 100, y: 50 },
      bitmap: base,
      split: null,
      gradientUrl: undefined,
      detail: {
        bitmap: detail,
        nativeW: 6000,
        nativeH: 4000,
        rect: { x: 2000, y: 1400, width: 1600, height: 1200 },
      },
    });
    expect(ctx.drawImage.mock.calls).toEqual([
      [base, -2000, -1300, 6000, 4000],
      [detail, 0, 100, 1600, 1200],
    ]);
    vi.unstubAllGlobals();
  });
});

function fakeCanvas(ctx: FakeCtx): HTMLCanvasElement {
  return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

function inputsWith(
  gradientUrl: string | undefined,
  bitmap: ImageBitmap | null = null,
): Draw2dInputs {
  return {
    wrapW: 800,
    wrapH: 600,
    canvasW: 400,
    canvasH: 300,
    pan: { x: 0, y: 0 },
    bitmap,
    split: null,
    gradientUrl,
  };
}

describe('drawCanvas2d — gradient placeholder image cache (PR #1124 review)', () => {
  let realImage: typeof Image;

  beforeEach(() => {
    realImage = globalThis.Image;
    (globalThis as unknown as { Image: unknown }).Image = FakeImage;
    FakeImage.instances = [];
  });

  afterEach(() => {
    globalThis.Image = realImage;
  });

  it('constructs one Image per URL — the second draw reuses the cache, synchronously', () => {
    const url = 'blob:gradient-reuse';
    const ctx = fakeCtx();
    const canvas = fakeCanvas(ctx);

    drawCanvas2d(canvas, inputsWith(url));
    expect(FakeImage.instances).toHaveLength(1);
    expect(FakeImage.instances[0].src).toBe(url);
    // Still loading → procedural fallback painted, no image draw yet.
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(ctx.createLinearGradient).toHaveBeenCalledTimes(1);

    // Load lands → exactly one repaint with the image.
    FakeImage.instances[0].fireLoad();
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(ctx.drawImage.mock.calls[0][0]).toBe(FakeImage.instances[0]);

    // Second draw with the same URL: NO new Image, paints synchronously.
    drawCanvas2d(canvas, inputsWith(url));
    expect(FakeImage.instances).toHaveLength(1);
    expect(ctx.drawImage).toHaveBeenCalledTimes(2);
  });

  it('draws issued while the image is still loading coalesce to one repaint', () => {
    const url = 'blob:gradient-coalesce';
    const ctx = fakeCtx();
    const canvas = fakeCanvas(ctx);

    drawCanvas2d(canvas, inputsWith(url));
    drawCanvas2d(canvas, inputsWith(url));
    expect(FakeImage.instances).toHaveLength(1);

    FakeImage.instances[0].fireLoad();
    // The first frame's deferred repaint is superseded by the second's —
    // exactly one repaint, not one per pending frame.
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
  });

  it('a stale load does not paint over a newer frame with a different URL', () => {
    const oldUrl = 'blob:gradient-stale-old';
    const newUrl = 'blob:gradient-stale-new';
    const ctx = fakeCtx();
    const canvas = fakeCanvas(ctx);

    drawCanvas2d(canvas, inputsWith(oldUrl)); // frame 1: old URL loading
    drawCanvas2d(canvas, inputsWith(newUrl)); // frame 2: switched before load
    const [oldImg, newImg] = FakeImage.instances;

    oldImg.fireLoad(); // resolves late — must NOT paint
    expect(ctx.drawImage).not.toHaveBeenCalled();

    newImg.fireLoad(); // current URL's load paints
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(ctx.drawImage.mock.calls[0][0]).toBe(newImg);
  });

  it('a stale gradient load does not paint over a frame with real pixels', () => {
    const url = 'blob:gradient-stale-vs-bitmap';
    const ctx = fakeCtx();
    const canvas = fakeCanvas(ctx);

    drawCanvas2d(canvas, inputsWith(url)); // gradient loading
    const bitmap = {} as ImageBitmap;
    drawCanvas2d(canvas, inputsWith(undefined, bitmap)); // decoded pixels arrive
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(ctx.drawImage.mock.calls[0][0]).toBe(bitmap);

    FakeImage.instances[0].fireLoad(); // late gradient load must NOT repaint
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
  });

  it('a failed load falls back to the procedural gradient permanently — no per-frame retry', () => {
    const url = 'blob:gradient-error';
    const ctx = fakeCtx();
    const canvas = fakeCanvas(ctx);

    drawCanvas2d(canvas, inputsWith(url));
    FakeImage.instances[0].fireError();

    drawCanvas2d(canvas, inputsWith(url));
    expect(FakeImage.instances).toHaveLength(1); // no new Image, no reload
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(ctx.createLinearGradient).toHaveBeenCalledTimes(2); // fallback both frames
  });
});
