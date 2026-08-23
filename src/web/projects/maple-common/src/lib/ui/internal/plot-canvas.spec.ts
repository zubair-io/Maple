import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginPlotDraw,
  clampUnit,
  drawVerticalBars,
  resolveColor,
  rgbChannels,
} from './plot-canvas';

// jsdom doesn't implement Canvas 2D (`getContext('2d')` returns `null`
// without the optional `canvas` npm package) — stub it the same way every
// plot component spec does, so these unit tests exercise real fillRect/
// clearRect call assertions instead of skipping canvas-backed cases.
function fakeCtx() {
  return { clearRect: vi.fn(), fillRect: vi.fn(), fillStyle: '' };
}

describe('resolveColor', () => {
  it('passes a literal color through unchanged', () => {
    expect(resolveColor(document.createElement('div'), '#fff')).toBe('#fff');
  });

  it('resolves a var(--token) reference against computed style', () => {
    const el = document.createElement('div');
    el.style.setProperty('--color-primary', '#123456');
    document.body.append(el);
    expect(resolveColor(el, 'var(--color-primary)')).toBe('#123456');
    el.remove();
  });

  it('falls back to the var() string when the token is unresolved', () => {
    const el = document.createElement('div');
    expect(resolveColor(el, 'var(--unset-token)')).toBe('var(--unset-token)');
  });
});

describe('beginPlotDraw', () => {
  let ctx: ReturnType<typeof fakeCtx>;

  beforeEach(() => {
    ctx = fakeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when there is no canvas ref', () => {
    expect(beginPlotDraw(undefined, 10, 10)).toBeNull();
  });

  it('returns the element + a cleared 2D context for a mounted canvas', () => {
    const canvas = document.createElement('canvas');
    const frame = beginPlotDraw({ nativeElement: canvas }, 10, 10);
    expect(frame).not.toBeNull();
    expect(frame?.canvasEl).toBe(canvas);
    expect(frame?.ctx).toBe(ctx);
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 10, 10);
  });
});

describe('clampUnit', () => {
  it('clamps to [0, 1]', () => {
    expect(clampUnit(-1)).toBe(0);
    expect(clampUnit(0.5)).toBe(0.5);
    expect(clampUnit(2)).toBe(1);
  });
});

describe('rgbChannels', () => {
  it('pairs each channel array with its literal color', () => {
    const channels = rgbChannels([1], [2], [3], { r: 'red', g: 'green', b: 'blue' });
    expect(channels).toEqual([
      { values: [1], color: 'red' },
      { values: [2], color: 'green' },
      { values: [3], color: 'blue' },
    ]);
  });
});

describe('drawVerticalBars', () => {
  function fakeCanvasCtx(): CanvasRenderingContext2D {
    return { fillRect: vi.fn(), fillStyle: '' } as unknown as CanvasRenderingContext2D;
  }

  it('is a no-op for an empty value list', () => {
    const ctx = fakeCanvasCtx();
    expect(() => drawVerticalBars(ctx, [], '#fff', 0, 100, 50, clampUnit)).not.toThrow();
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it('fills one rect per value, sized to fit the lane', () => {
    const ctx = fakeCanvasCtx();
    drawVerticalBars(ctx, [0.2, 0.8], '#fff', 0, 100, 50, clampUnit);
    expect(ctx.fillRect).toHaveBeenCalledTimes(2);
  });
});
