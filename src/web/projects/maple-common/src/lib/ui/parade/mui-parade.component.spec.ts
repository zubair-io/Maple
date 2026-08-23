import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuiParadeComponent } from './mui-parade.component';

function fakeCtx() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: '',
  };
}

describe('MuiParadeComponent', () => {
  let ctx: ReturnType<typeof fakeCtx>;

  beforeEach(() => {
    ctx = fakeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('draws each channel into its own lane, one column per sample', () => {
    const fixture = TestBed.createComponent(MuiParadeComponent);
    fixture.componentRef.setInput('r', [0.2, 0.4]);
    fixture.componentRef.setInput('g', [0.5, 0.6, 0.7]);
    fixture.componentRef.setInput('b', [0.1]);
    fixture.componentRef.setInput('width', 120);
    fixture.componentRef.setInput('height', 40);
    fixture.detectChanges();

    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 120, 40);
    // 2 + 3 + 1 columns total across the three lanes.
    expect(ctx.fillRect).toHaveBeenCalledTimes(6);
  });

  it('keeps each channel lane within its third of the canvas width', () => {
    const fixture = TestBed.createComponent(MuiParadeComponent);
    fixture.componentRef.setInput('r', [1]);
    fixture.componentRef.setInput('g', [1]);
    fixture.componentRef.setInput('b', [1]);
    fixture.componentRef.setInput('width', 120);
    fixture.componentRef.setInput('height', 40);
    fixture.detectChanges();

    const laneXs = ctx.fillRect.mock.calls.map((call: unknown[]) => call[0] as number);
    // Three single-sample lanes: each x should be a distinct lane origin,
    // strictly increasing left to right.
    expect(laneXs[0]).toBeLessThan(laneXs[1]);
    expect(laneXs[1]).toBeLessThan(laneXs[2]);
  });
});
