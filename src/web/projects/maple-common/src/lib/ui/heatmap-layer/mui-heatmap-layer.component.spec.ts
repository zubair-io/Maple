import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuiHeatmapLayerComponent } from './mui-heatmap-layer.component';

function fakeCtx() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: '',
  };
}

describe('MuiHeatmapLayerComponent', () => {
  let ctx: ReturnType<typeof fakeCtx>;

  beforeEach(() => {
    ctx = fakeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('draws one rect per nonzero cell, skipping zero-density cells', () => {
    const fixture = TestBed.createComponent(MuiHeatmapLayerComponent);
    fixture.componentRef.setInput('grid', [
      [0, 0.5],
      [1, 0],
    ]);
    fixture.detectChanges();

    expect(ctx.clearRect).toHaveBeenCalled();
    expect(ctx.fillRect).toHaveBeenCalledTimes(2);
  });

  it('sizes each cell to the grid dimensions against the canvas box', () => {
    const fixture = TestBed.createComponent(MuiHeatmapLayerComponent);
    fixture.componentRef.setInput('grid', [
      [1, 1],
      [1, 1],
    ]);
    fixture.componentRef.setInput('width', 100);
    fixture.componentRef.setInput('height', 50);
    fixture.detectChanges();

    const [, , cellW, cellH] = ctx.fillRect.mock.calls[0];
    expect(cellW).toBeCloseTo(50);
    expect(cellH).toBeCloseTo(25);
  });

  it('uses a literal color as-is when it is not a var() reference', () => {
    const fixture = TestBed.createComponent(MuiHeatmapLayerComponent);
    fixture.componentRef.setInput('grid', [[1]]);
    fixture.componentRef.setInput('color', '#c4493a');
    fixture.detectChanges();

    expect(ctx.fillStyle).toContain('196, 73, 58'); // #c4493a parsed to rgb
  });

  it('draws nothing for an empty grid', () => {
    const fixture = TestBed.createComponent(MuiHeatmapLayerComponent);
    fixture.componentRef.setInput('grid', []);
    fixture.detectChanges();

    expect(ctx.clearRect).toHaveBeenCalled();
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});
