import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuiWaveformComponent } from './mui-waveform.component';

function fakeCtx() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: '',
  };
}

describe('MuiWaveformComponent', () => {
  let ctx: ReturnType<typeof fakeCtx>;

  beforeEach(() => {
    ctx = fakeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('draws one column per sample, scaled to the sample value', () => {
    const fixture = TestBed.createComponent(MuiWaveformComponent);
    fixture.componentRef.setInput('luma', [0, 0.5, 1]);
    fixture.componentRef.setInput('width', 90);
    fixture.componentRef.setInput('height', 40);
    fixture.detectChanges();

    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 90, 40);
    expect(ctx.fillRect).toHaveBeenCalledTimes(3);

    const [, , , tallest] = ctx.fillRect.mock.calls[2];
    const [, , , shortest] = ctx.fillRect.mock.calls[0];
    expect(tallest).toBeGreaterThan(shortest);
  });

  it('draws nothing for an empty sample set beyond the clear', () => {
    const fixture = TestBed.createComponent(MuiWaveformComponent);
    fixture.componentRef.setInput('luma', []);
    fixture.detectChanges();

    expect(ctx.clearRect).toHaveBeenCalled();
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it('redraws when the samples change', () => {
    const fixture = TestBed.createComponent(MuiWaveformComponent);
    fixture.componentRef.setInput('luma', [0.2]);
    fixture.detectChanges();
    const before = ctx.fillRect.mock.calls.length;

    fixture.componentRef.setInput('luma', [0.2, 0.4]);
    fixture.detectChanges();

    expect(ctx.fillRect.mock.calls.length).toBeGreaterThan(before);
  });
});
