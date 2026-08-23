import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuiVectorscopeComponent } from './mui-vectorscope.component';

function fakeCtx() {
  return {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
  };
}

describe('MuiVectorscopeComponent', () => {
  let ctx: ReturnType<typeof fakeCtx>;

  beforeEach(() => {
    ctx = fakeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('draws the graticule (outer circle + 6 spokes) even with no samples', () => {
    const fixture = TestBed.createComponent(MuiVectorscopeComponent);
    fixture.componentRef.setInput('samples', []);
    fixture.detectChanges();

    expect(ctx.clearRect).toHaveBeenCalled();
    // 1 arc for the outer circle, 6 lineTo for the spokes.
    expect(ctx.arc).toHaveBeenCalledTimes(1);
    expect(ctx.lineTo).toHaveBeenCalledTimes(6);
    expect(ctx.fill).not.toHaveBeenCalled();
  });

  it('plots one dot per sample beyond the graticule', () => {
    const fixture = TestBed.createComponent(MuiVectorscopeComponent);
    fixture.componentRef.setInput('samples', [
      { r: 1, g: 0, b: 0 },
      { r: 0, g: 1, b: 0 },
      { r: 0, g: 0, b: 1 },
    ]);
    fixture.detectChanges();

    // 1 outer-circle arc + 3 sample dots.
    expect(ctx.arc).toHaveBeenCalledTimes(4);
    expect(ctx.fill).toHaveBeenCalledTimes(3);
  });

  it('places a pure-red sample away from the neutral center (nonzero Cb/Cr)', () => {
    const fixture = TestBed.createComponent(MuiVectorscopeComponent);
    fixture.componentRef.setInput('samples', [{ r: 1, g: 0, b: 0 }]);
    fixture.componentRef.setInput('size', 64);
    fixture.detectChanges();

    const dotArcCall = ctx.arc.mock.calls[1]; // [0] is the outer circle
    const [x, y] = dotArcCall;
    expect(x).not.toBeCloseTo(32);
    expect(y).not.toBeCloseTo(32);
  });
});
