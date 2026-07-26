// tone-curve.spec.ts — curve math + point-editing rules (#1540 → #367).

import { describe, it, expect } from 'vitest';
import { curvePathData, evalMonotonicCubic, prepareCurve } from './tone-curve-math';
import {
  MIN_X_GAP,
  hitTest,
  insertPoint,
  isBareIdentity,
  materializeCurve,
  movePoint,
  removePoint,
} from './tone-curve-edit';
import type { ToneCurvePoint } from '../../models/adjustment-model';

/**
 * The shared curve-editor parity anchor (#367). Identical knots and
 * samples are asserted in raw-core's
 * `monotonic_cubic_matches_the_cross_platform_parity_anchor` and in
 * `ToneCurveMathTests.swift`. The three ports must agree, because the
 * widget's job is to draw the shape the pipeline renders — a plot that
 * interpolates differently is a lie about the photo.
 */
const PARITY_KNOTS: ToneCurvePoint[] = [
  [0.0, 0.0],
  [0.25, 0.15],
  [0.6, 0.72],
  [1.0, 1.0],
];
const PARITY_SAMPLES = [
  0.0, 0.047657, 0.103543, 0.215379, 0.386152, 0.570335, 0.72, 0.816116, 0.883214, 0.938705, 1.0,
];

describe('evalMonotonicCubic', () => {
  it('matches the raw-core parity anchor to 1e-5', () => {
    const curve = prepareCurve(PARITY_KNOTS);
    PARITY_SAMPLES.forEach((expected, i) => {
      expect(evalMonotonicCubic(curve, i / 10)).toBeCloseTo(expected, 5);
    });
  });

  it('treats the empty curve as identity', () => {
    const curve = prepareCurve([]);
    expect(evalMonotonicCubic(curve, 0.37)).toBeCloseTo(0.37, 6);
  });

  it('treats a single knot as a constant, like the stage does', () => {
    const curve = prepareCurve([[0.5, 0.7]]);
    expect(evalMonotonicCubic(curve, 0.1)).toBeCloseTo(0.7, 6);
    expect(evalMonotonicCubic(curve, 0.9)).toBeCloseTo(0.7, 6);
  });

  it('stays monotonic through a steep knot (no Fritsch-Carlson overshoot)', () => {
    const curve = prepareCurve([
      [0, 0],
      [0.45, 0.05],
      [0.55, 0.95],
      [1, 1],
    ]);
    const samples = Array.from({ length: 101 }, (_, i) => evalMonotonicCubic(curve, i / 100));
    samples.forEach((y, i) => {
      if (i > 0) expect(y).toBeGreaterThanOrEqual(samples[i - 1] - 1e-6);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    });
  });

  it('sorts unordered input and keeps the later of two equal-x knots', () => {
    const curve = prepareCurve([
      [1, 1],
      [0.5, 0.2],
      [0.5, 0.8],
      [0, 0],
    ]);
    expect(curve.knots.map((k) => k[0])).toEqual([0, 0.5, 1]);
    expect(evalMonotonicCubic(curve, 0.5)).toBeCloseTo(0.8, 6);
  });
});

describe('curvePathData', () => {
  it('draws the diagonal for the identity curve', () => {
    const d = curvePathData([], 100, 4);
    expect(d).toBe('M 0.00 100.00 L 25.00 75.00 L 50.00 50.00 L 75.00 25.00 L 100.00 0.00');
  });

  it('flips y exactly once — a lifted curve sits ABOVE the diagonal', () => {
    const d = curvePathData(
      [
        [0, 0],
        [0.5, 0.8],
        [1, 1],
      ],
      100,
      2,
    );
    // Mid sample: y = 0.8 → SVG y = 20, i.e. nearer the top than 50.
    expect(d).toContain('50.00 20.00');
  });
});

describe('materializeCurve', () => {
  it('turns the identity into the two corner anchors', () => {
    expect(materializeCurve([])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it('sorts an out-of-order list and copies it', () => {
    const input: ToneCurvePoint[] = [
      [0.8, 0.9],
      [0.2, 0.1],
    ];
    const out = materializeCurve(input);
    expect(out).toEqual([
      [0.2, 0.1],
      [0.8, 0.9],
    ]);
    expect(out[0]).not.toBe(input[1]);
  });
});

describe('insertPoint', () => {
  it('adds a knot between the anchors of an identity curve', () => {
    expect(insertPoint([], 0.5, 0.7)).toEqual([
      [0, 0],
      [0.5, 0.7],
      [1, 1],
    ]);
  });

  it('never produces a lone knot — the stage would flatten the image', () => {
    const out = insertPoint([], 0.3, 0.4);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([1, 1]);
  });

  it('refuses a knot that collides with an existing x', () => {
    const start = insertPoint([], 0.5, 0.7);
    expect(insertPoint(start, 0.5 + MIN_X_GAP / 2, 0.2)).toEqual(start);
  });

  it('clamps into the authoring domain', () => {
    expect(insertPoint([], 0.5, 1.8)).toContainEqual([0.5, 1]);
    expect(insertPoint([], 0.5, -0.4)).toContainEqual([0.5, 0]);
  });
});

describe('movePoint', () => {
  const three = insertPoint([], 0.5, 0.5);

  it('moves an interior knot freely between its neighbours', () => {
    expect(movePoint(three, 1, 0.7, 0.3)).toEqual([
      [0, 0],
      [0.7, 0.3],
      [1, 1],
    ]);
  });

  it('pins the endpoints in x but lets them move in y', () => {
    expect(movePoint(three, 0, 0.4, 0.25)).toEqual([
      [0, 0.25],
      [0.5, 0.5],
      [1, 1],
    ]);
    expect(movePoint(three, 2, 0.4, 0.8)).toEqual([
      [0, 0],
      [0.5, 0.5],
      [1, 0.8],
    ]);
  });

  it('holds an interior knot off its neighbours by MIN_X_GAP', () => {
    const dragLeft = movePoint(three, 1, -5, 0.5);
    expect(dragLeft[1][0]).toBeCloseTo(MIN_X_GAP, 6);
    const dragRight = movePoint(three, 1, 5, 0.5);
    expect(dragRight[1][0]).toBeCloseTo(1 - MIN_X_GAP, 6);
  });

  it('ignores an out-of-range index', () => {
    expect(movePoint(three, 9, 0.5, 0.5)).toEqual(three);
  });
});

describe('removePoint', () => {
  it('drops an interior knot', () => {
    const four = insertPoint(insertPoint([], 0.3, 0.2), 0.7, 0.8);
    expect(removePoint(four, 1)).toEqual([
      [0, 0],
      [0.7, 0.8],
      [1, 1],
    ]);
  });

  it('will not delete an endpoint', () => {
    const three = insertPoint([], 0.5, 0.5);
    expect(removePoint(three, 0)).toEqual(three);
    expect(removePoint(three, 2)).toEqual(three);
  });

  it('collapses back to the EMPTY identity so the sidecar stays clean', () => {
    const three = insertPoint([], 0.5, 0.5);
    expect(removePoint(three, 1)).toEqual([]);
  });

  it('keeps a moved endpoint rather than collapsing', () => {
    const lifted = movePoint(insertPoint([], 0.5, 0.5), 2, 1, 0.8);
    expect(removePoint(lifted, 1)).toEqual([
      [0, 0],
      [1, 0.8],
    ]);
  });
});

describe('isBareIdentity', () => {
  it('recognises exactly the two corner anchors', () => {
    expect(
      isBareIdentity([
        [0, 0],
        [1, 1],
      ]),
    ).toBe(true);
    expect(
      isBareIdentity([
        [0, 0.1],
        [1, 1],
      ]),
    ).toBe(false);
    expect(isBareIdentity([])).toBe(false);
  });
});

describe('hitTest', () => {
  const three = insertPoint([], 0.5, 0.5);

  it('finds the knot under the cursor', () => {
    expect(hitTest(three, 0.51, 0.49, 0.05)).toBe(1);
  });

  it('returns -1 on empty canvas', () => {
    expect(hitTest(three, 0.2, 0.9, 0.05)).toBe(-1);
  });

  it('hits the materialised anchors of an identity curve', () => {
    expect(hitTest([], 0.01, 0.01, 0.05)).toBe(0);
    expect(hitTest([], 0.99, 0.99, 0.05)).toBe(1);
  });
});
