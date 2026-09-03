import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  chromaBt601,
  chromaRec709,
  MuiVectorscopeComponent,
  rotated,
  SKIN_TONE_LINE_ANGLE_DEG,
  targetAngleDeg,
  VECTORSCOPE_TARGETS,
} from './mui-vectorscope.component';

function fakeCtx() {
  return {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
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

  it('draws the graticule (outer circle + 6 spokes) and the 6 broadcast targets even with no samples', () => {
    const fixture = TestBed.createComponent(MuiVectorscopeComponent);
    fixture.componentRef.setInput('samples', []);
    fixture.detectChanges();

    expect(ctx.clearRect).toHaveBeenCalled();
    // 1 arc for the outer circle + 6 arcs for the always-on target dots.
    expect(ctx.arc).toHaveBeenCalledTimes(7);
    expect(ctx.lineTo).toHaveBeenCalledTimes(6);
    // The 6 target dots each fill once; no samples means no sample dots.
    expect(ctx.fill).toHaveBeenCalledTimes(6);
  });

  it('plots one dot per sample beyond the graticule and targets', () => {
    const fixture = TestBed.createComponent(MuiVectorscopeComponent);
    fixture.componentRef.setInput('samples', [
      { r: 1, g: 0, b: 0 },
      { r: 0, g: 1, b: 0 },
      { r: 0, g: 0, b: 1 },
    ]);
    fixture.detectChanges();

    // 1 outer-circle arc + 6 target arcs + 3 sample dots.
    expect(ctx.arc).toHaveBeenCalledTimes(10);
    // 6 target fills + 3 sample fills.
    expect(ctx.fill).toHaveBeenCalledTimes(9);
  });

  it('places a pure-red sample away from the neutral center (nonzero Cb/Cr)', () => {
    const fixture = TestBed.createComponent(MuiVectorscopeComponent);
    fixture.componentRef.setInput('samples', [{ r: 1, g: 0, b: 0 }]);
    fixture.componentRef.setInput('size', 64);
    fixture.detectChanges();

    // arc calls: [0] outer circle, [1..6] the 6 target dots, [7] the sample dot.
    const dotArcCall = ctx.arc.mock.calls[7];
    const [x, y] = dotArcCall;
    expect(x).not.toBeCloseTo(32);
    expect(y).not.toBeCloseTo(32);
  });

  it('draws density cells instead of sample dots when bins is set', () => {
    const fixture = TestBed.createComponent(MuiVectorscopeComponent);
    fixture.componentRef.setInput('samples', []);
    const bins: number[][] = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    bins[1][2] = 10;
    fixture.componentRef.setInput('bins', bins);
    fixture.detectChanges();

    expect(ctx.fillRect).toHaveBeenCalledTimes(1);
  });

  it('draws the skin-tone line wedge + centre line when showSkinToneLine is set', () => {
    const fixture = TestBed.createComponent(MuiVectorscopeComponent);
    fixture.componentRef.setInput('samples', []);
    fixture.componentRef.setInput('showSkinToneLine', true);
    const strokeCallsBefore = 1 /* outer circle */ + 6; /* spokes */
    fixture.detectChanges();

    // 2 wedge-edge strokes + 1 centre-line stroke, on top of the graticule's own.
    expect(ctx.stroke).toHaveBeenCalledTimes(strokeCallsBefore + 3);
  });
});

describe('vectorscope math', () => {
  it('pure grey has zero chroma in both colour spaces', () => {
    // toBeCloseTo, not toEqual — the matrix coefficients don't sum to
    // exactly zero in IEEE-754 double precision (e.g. cr lands at ~1.4e-17,
    // not 0), same reason the Swift equivalent uses `accuracy: 1e-9`.
    const bt601 = chromaBt601(0.5, 0.5, 0.5);
    expect(bt601.cb).toBeCloseTo(0, 9);
    expect(bt601.cr).toBeCloseTo(0, 9);
    const rec709 = chromaRec709(0.5, 0.5, 0.5);
    expect(rec709.cb).toBeCloseTo(0, 9);
    expect(rec709.cr).toBeCloseTo(0, 9);
  });

  it('Rec.709 chroma matches Rec.601 cb but diverges on cr for saturated blue', () => {
    // cb's B-channel coefficient is exactly 0.5 in BOTH standards (a shared
    // property of how Cb is normalized), so pure blue (r=g=0) never engages
    // the standards' only real difference — cr's B coefficient genuinely
    // differs (-0.081312 BT.601 vs -0.045847 Rec.709), so that's the axis
    // that actually demonstrates the divergence for this colour.
    const rec709 = chromaRec709(0, 0, 1);
    const rec601 = chromaBt601(0, 0, 1);
    expect(rec709.cb).toBeCloseTo(rec601.cb, 9);
    expect(rec709.cr).not.toBeCloseTo(rec601.cr, 6);
  });

  it('target angles go monotonically around the wheel once and sum to 360', () => {
    // Real broadcast vectorscope targets are NOT evenly spaced at 60° — the
    // eye's non-uniform hue sensitivity is baked into the Rec.709 matrix
    // coefficients (alternating ~54°/~72° gaps, not a uniform hexagon).
    const angles = VECTORSCOPE_TARGETS.map(targetAngleDeg);
    let totalSweep = 0;
    for (let i = 0; i < angles.length; i++) {
      const next = angles[(i + 1) % angles.length];
      let gap = next - angles[i];
      if (gap <= 0) gap += 360;
      expect(gap).toBeGreaterThan(30);
      expect(gap).toBeLessThan(90);
      totalSweep += gap;
    }
    expect(totalSweep).toBeCloseTo(360, 6);
  });

  it('rotating the red target by its own negative angle lands it at (1, 0)', () => {
    const redAngle = targetAngleDeg('red');
    const rad = (redAngle * Math.PI) / 180;
    const result = rotated(Math.cos(rad), Math.sin(rad), -redAngle);
    expect(result.cb).toBeCloseTo(1, 6);
    expect(result.cr).toBeCloseTo(0, 6);
  });

  it('the skin-tone line angle matches the core range preset convention', () => {
    // Pins the CONSTANT (a graticule convention), not a derivation from the
    // Oklab `skinTone` range preset — the two are independently chosen and
    // happen to both target real skin (spec §11).
    expect(SKIN_TONE_LINE_ANGLE_DEG).toBeCloseTo(123.0, 2);
  });
});
