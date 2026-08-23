// jsdom's `<canvas>.getContext('2d')` is null (documented in
// image-canvas.draw2d.spec.ts and mui-qr-code.component.spec.ts), so the 2D
// context is stubbed with spies — what's under test is the component's own
// drawing math (bar count, peak normalization, per-channel color), not the
// browser's real rasterizer.

import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuiHistogramComponent } from './mui-histogram.component';

function fakeCtx() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: '',
  };
}

describe('MuiHistogramComponent', () => {
  let ctx: ReturnType<typeof fakeCtx>;

  beforeEach(() => {
    ctx = fakeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears the canvas and draws one bar per bin per channel', () => {
    const fixture = TestBed.createComponent(MuiHistogramComponent);
    fixture.componentRef.setInput('r', [1, 2, 3, 4]);
    fixture.componentRef.setInput('g', [4, 3, 2, 1]);
    fixture.componentRef.setInput('b', [2, 2, 2, 2]);
    fixture.componentRef.setInput('width', 100);
    fixture.componentRef.setInput('height', 50);
    fixture.detectChanges();

    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 100, 50);
    // 4 bins x 3 channels
    expect(ctx.fillRect).toHaveBeenCalledTimes(12);
  });

  it('scales the tallest bar to the drawable height, normalized against the global peak', () => {
    const fixture = TestBed.createComponent(MuiHistogramComponent);
    fixture.componentRef.setInput('r', [10]);
    fixture.componentRef.setInput('g', [0]);
    fixture.componentRef.setInput('b', [0]);
    fixture.componentRef.setInput('width', 40);
    fixture.componentRef.setInput('height', 60);
    fixture.detectChanges();

    // Single bin at the global peak (10) fills the full drawable height
    // (canvas height minus the 2px baseline inset).
    const [, y, , barHeight] = ctx.fillRect.mock.calls[0];
    expect(barHeight).toBeCloseTo(58);
    expect(y).toBeCloseTo(60 - 58);
  });

  it('redraws when the input bins change', () => {
    const fixture = TestBed.createComponent(MuiHistogramComponent);
    fixture.componentRef.setInput('r', [1]);
    fixture.componentRef.setInput('g', [1]);
    fixture.componentRef.setInput('b', [1]);
    fixture.detectChanges();
    const callsBefore = ctx.fillRect.mock.calls.length;

    fixture.componentRef.setInput('r', [1, 2]);
    fixture.detectChanges();

    expect(ctx.fillRect.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
