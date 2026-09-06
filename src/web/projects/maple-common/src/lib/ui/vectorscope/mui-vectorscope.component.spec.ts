import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  binCentre,
  chromaBt601,
  chromaRec709,
  MuiVectorscopeComponent,
  normalizedDeg,
  ringRGB,
  rotated,
  SKIN_TONE_LINE_ANGLE_DEG,
  TARGET_RGB,
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
    closePath: vi.fn(),
    setLineDash: vi.fn(),
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

  it('draws the hue ring, dashed spokes and the 6 broadcast targets even with no samples', () => {
    const fixture = TestBed.createComponent(MuiVectorscopeComponent);
    fixture.componentRef.setInput('samples', []);
    fixture.detectChanges();

    expect(ctx.clearRect).toHaveBeenCalled();
    // The hue ring is drawn as 2-degree arc segments, so the rim alone is
    // ~180 arcs. Asserted as a floor rather than an exact count: the
    // segment step is a rendering detail, "the ring is drawn at all" is the
    // contract.
    expect(ctx.arc.mock.calls.length).toBeGreaterThanOrEqual(180);
    // Spokes are dashed.
    expect(ctx.setLineDash).toHaveBeenCalled();
    // One spoke per target.
    expect(ctx.lineTo).toHaveBeenCalledTimes(VECTORSCOPE_TARGETS.length);
    // The 6 target dots each fill once; no samples means no sample dots.
    expect(ctx.fill).toHaveBeenCalledTimes(VECTORSCOPE_TARGETS.length);
  });

  it('plots one additional dot per sample', () => {
    const fixture = TestBed.createComponent(MuiVectorscopeComponent);
    fixture.componentRef.setInput('samples', []);
    fixture.detectChanges();
    const baseArcs = ctx.arc.mock.calls.length;
    const baseFills = ctx.fill.mock.calls.length;
    // Cleared so the counts below are a TRUE delta — the second
    // detectChanges redraws the whole chrome, so without this the "delta"
    // silently includes another full graticule.
    ctx.arc.mockClear();
    ctx.fill.mockClear();

    // Measured as a delta off the empty render rather than against a hard
    // total: the chrome's own call count is a rendering detail that has
    // already changed once (#3350), and pinning it here just breaks this
    // test every time the graticule is restyled.
    fixture.componentRef.setInput('samples', [
      { r: 1, g: 0, b: 0 },
      { r: 0, g: 1, b: 0 },
      { r: 0, g: 0, b: 1 },
    ]);
    fixture.detectChanges();

    expect(ctx.arc.mock.calls.length).toBe(baseArcs + 3);
    expect(ctx.fill.mock.calls.length).toBe(baseFills + 3);
  });

  it('places a pure-red sample away from the neutral center (nonzero Cb/Cr)', () => {
    const fixture = TestBed.createComponent(MuiVectorscopeComponent);
    fixture.componentRef.setInput('samples', [{ r: 1, g: 0, b: 0 }]);
    fixture.componentRef.setInput('size', 64);
    fixture.detectChanges();

    // The sample dot is the LAST arc drawn — indexed from the end so the
    // chrome ahead of it can grow without breaking this.
    const dotArcCall = ctx.arc.mock.calls[ctx.arc.mock.calls.length - 1];
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

  it('tolerates a ragged bins array without drawing NaN cells', () => {
    const fixture = TestBed.createComponent(MuiVectorscopeComponent);
    fixture.componentRef.setInput('samples', []);
    fixture.componentRef.setInput('bins', [[0, 7], [3]]);
    fixture.detectChanges();

    expect(ctx.fillRect).toHaveBeenCalledTimes(2);
  });

  it('adds a filled skin-tone cone, centre line and person marker when enabled', () => {
    const fixture = TestBed.createComponent(MuiVectorscopeComponent);
    fixture.componentRef.setInput('samples', []);
    fixture.detectChanges();
    const baseStrokes = ctx.stroke.mock.calls.length;
    const baseFills = ctx.fill.mock.calls.length;
    const baseCloses = ctx.closePath.mock.calls.length;
    const baseArcs = ctx.arc.mock.calls.length;
    // See the note in the sample test: cleared so these are true deltas and
    // not "one more full chrome, plus the overlay".
    ctx.stroke.mockClear();
    ctx.fill.mockClear();
    ctx.closePath.mockClear();
    ctx.arc.mockClear();

    fixture.componentRef.setInput('showSkinToneLine', true);
    fixture.detectChanges();

    // The cone is a CLOSED, FILLED path — the thing that changed in #3350
    // (it used to be two bare edge lines), so it is what this asserts.
    expect(ctx.closePath.mock.calls.length).toBe(baseCloses + 1);
    expect(ctx.fill.mock.calls.length).toBe(baseFills + 1);
    // Cone outline + centre line, on top of the chrome's own strokes.
    expect(ctx.stroke.mock.calls.length).toBeGreaterThanOrEqual(baseStrokes + 2);
    // Head circle + shoulders arc for the person marker.
    expect(ctx.arc.mock.calls.length).toBeGreaterThanOrEqual(baseArcs + 2);
  });
});

describe('ringRGB', () => {
  // Parity with Apple's MuiVectorscopeMathTests — the ring must agree with
  // the target dots, or it drifts against the markers.
  it('matches each target colour at that target angle', () => {
    for (const target of VECTORSCOPE_TARGETS) {
      const [r, g, b] = ringRGB(targetAngleDeg(target));
      const want = TARGET_RGB[target];
      expect(r).toBeCloseTo(want[0], 3);
      expect(g).toBeCloseTo(want[1], 3);
      expect(b).toBeCloseTo(want[2], 3);
    }
  });

  it('blends between adjacent targets', () => {
    const red = targetAngleDeg('red');
    const yellow = targetAngleDeg('yellow');
    // Counter-clockwise from red (~103°) to yellow (~175°), so the midpoint
    // walks forward from RED, not from yellow.
    const mid = normalizedDeg(red + normalizedDeg(yellow - red) / 2);
    const [r, g, b] = ringRGB(mid);
    expect(r).toBeCloseTo(1, 3);
    expect(g).toBeGreaterThan(0.2);
    expect(g).toBeLessThan(0.8);
    expect(b).toBeCloseTo(0, 3);
  });

  it('wraps angles outside 0..360', () => {
    const base = ringRGB(40);
    for (const equivalent of [400, -320, 760]) {
      const got = ringRGB(equivalent);
      expect(got[0]).toBeCloseTo(base[0], 3);
      expect(got[1]).toBeCloseTo(base[1], 3);
      expect(got[2]).toBeCloseTo(base[2], 3);
    }
  });
});

describe('binCentre', () => {
  it('bin centres tile the chroma square exactly', () => {
    expect(binCentre(0, 0, 4)).toEqual({ cb: -0.375, cr: 0.375 });
    expect(binCentre(3, 3, 4)).toEqual({ cb: 0.375, cr: -0.375 });
  });
});
