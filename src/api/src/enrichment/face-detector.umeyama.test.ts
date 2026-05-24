/**
 * face-detector — Umeyama similarity-transform golden tests.
 *
 * The math behind `alignFaceCrop` is small enough to unit-test directly
 * — point-to-point round-trips, known affine cases (pure translation,
 * pure rotation, pure scale), and the InsightFace `arcface_dst`
 * template against a representative landmark set. These tests catch
 * sign-flip / axis-swap regressions before the larger ONNX integration
 * test exercises the warp end-to-end.
 *
 * All tolerances are 1e-6 unless otherwise noted — the closed-form
 * Umeyama solution is numerically clean for well-conditioned 5-point
 * inputs. Where we tighten or loosen, a comment explains why.
 */

import { describe, it, expect } from 'bun:test';
import {
  applySimilarity,
  invertSimilarity,
  umeyamaSimilarity,
  type Similarity2D,
} from './face-similarity.ts';

const TIGHT = 1e-6;

/** Apply transform to a list of points (test helper). */
function applyAll(
  s: Similarity2D,
  pts: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  return pts.map(([x, y]) => applySimilarity(s, x, y));
}

/** Euclidean distance between two points. */
function dist(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

describe('umeyamaSimilarity — degenerate inputs', () => {
  it('rejects length mismatch', () => {
    expect(() =>
      umeyamaSimilarity(
        [
          [0, 0],
          [1, 0],
        ],
        [[0, 0]],
      ),
    ).toThrow(/length mismatch/);
  });

  it('rejects < 2 point pairs', () => {
    expect(() => umeyamaSimilarity([[0, 0]], [[1, 1]])).toThrow(/at least 2/);
  });

  it('rejects zero-variance source (all coincident)', () => {
    expect(() =>
      umeyamaSimilarity(
        [
          [0, 0],
          [0, 0],
          [0, 0],
        ],
        [
          [1, 1],
          [2, 2],
          [3, 3],
        ],
      ),
    ).toThrow(/zero variance/);
  });
});

describe('umeyamaSimilarity — closed-form known cases', () => {
  it('identity: same src → same dst gives identity-ish transform', () => {
    const pts: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ];
    const s = umeyamaSimilarity(pts, pts);
    expect(s.a).toBeCloseTo(1, 6);
    expect(s.b).toBeCloseTo(0, 6);
    expect(s.tx).toBeCloseTo(0, 6);
    expect(s.ty).toBeCloseTo(0, 6);
  });

  it('pure translation (+10, -5)', () => {
    const src: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ];
    const dst: Array<[number, number]> = src.map(([x, y]) => [x + 10, y - 5] as [number, number]);
    const s = umeyamaSimilarity(src, dst);
    expect(s.a).toBeCloseTo(1, 6);
    expect(s.b).toBeCloseTo(0, 6);
    expect(s.tx).toBeCloseTo(10, 6);
    expect(s.ty).toBeCloseTo(-5, 6);
  });

  it('pure uniform scale (×3)', () => {
    const src: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ];
    const dst: Array<[number, number]> = src.map(([x, y]) => [x * 3, y * 3] as [number, number]);
    const s = umeyamaSimilarity(src, dst);
    expect(s.a).toBeCloseTo(3, 6);
    expect(s.b).toBeCloseTo(0, 6);
    expect(s.tx).toBeCloseTo(0, 6);
    expect(s.ty).toBeCloseTo(0, 6);
  });

  it('pure rotation (+90°)', () => {
    // 90° CCW: (x, y) → (-y, x). Matrix form [[0,-1],[1,0]] → (a=0, b=1).
    const src: Array<[number, number]> = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ];
    const dst: Array<[number, number]> = src.map(([x, y]) => [-y, x] as [number, number]);
    const s = umeyamaSimilarity(src, dst);
    expect(s.a).toBeCloseTo(0, 5);
    expect(s.b).toBeCloseTo(1, 5);
    expect(s.tx).toBeCloseTo(0, 5);
    expect(s.ty).toBeCloseTo(0, 5);
  });

  it('rotation + scale + translation composite', () => {
    // 30° CCW × 2 + translate (5, 7). Matrix: a = 2*cos30 = sqrt(3),
    // b = 2*sin30 = 1.
    const angle = Math.PI / 6;
    const scale = 2;
    const a = scale * Math.cos(angle);
    const b = scale * Math.sin(angle);
    const tx = 5;
    const ty = 7;
    const src: Array<[number, number]> = [
      [0, 0],
      [10, 0],
      [0, 10],
      [10, 10],
      [5, 5],
    ];
    const dst: Array<[number, number]> = src.map(
      ([x, y]) => [a * x - b * y + tx, b * x + a * y + ty] as [number, number],
    );
    const s = umeyamaSimilarity(src, dst);
    expect(s.a).toBeCloseTo(a, 5);
    expect(s.b).toBeCloseTo(b, 5);
    expect(s.tx).toBeCloseTo(tx, 5);
    expect(s.ty).toBeCloseTo(ty, 5);
  });
});

describe('umeyamaSimilarity — point round-trip', () => {
  it('transforms src to within numerical noise of dst (composite case)', () => {
    const angle = -Math.PI / 4; // -45°
    const scale = 1.7;
    const a = scale * Math.cos(angle);
    const b = scale * Math.sin(angle);
    const tx = -3;
    const ty = 2;
    const src: Array<[number, number]> = [
      [0, 0],
      [2, 0],
      [0, 2],
      [2, 2],
      [1, 1],
    ];
    const dst: Array<[number, number]> = src.map(
      ([x, y]) => [a * x - b * y + tx, b * x + a * y + ty] as [number, number],
    );
    const s = umeyamaSimilarity(src, dst);
    const round = applyAll(s, src);
    for (let i = 0; i < src.length; i++) {
      expect(dist(round[i]!, dst[i]!)).toBeLessThan(TIGHT * 100);
    }
  });
});

describe('umeyamaSimilarity — arcface_dst golden', () => {
  // The InsightFace canonical 5-point template. We pin it here for the
  // golden test so a refactor that drops a digit gets caught immediately.
  const ARCFACE_DST: ReadonlyArray<readonly [number, number]> = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
  ];

  it('identity transform when source equals arcface_dst', () => {
    const s = umeyamaSimilarity(ARCFACE_DST, ARCFACE_DST);
    expect(s.a).toBeCloseTo(1, 6);
    expect(s.b).toBeCloseTo(0, 6);
    expect(s.tx).toBeCloseTo(0, 4);
    expect(s.ty).toBeCloseTo(0, 4);
  });

  it('solves a representative face → arcface_dst case (face tilted -15°, 300px wide)', () => {
    // Simulate a real detector output: a ~300px-wide face on a 1000×750
    // thumbnail, tilted by -15° (head leaning right). We synthesise the
    // source landmarks by applying the INVERSE of a known similarity to
    // arcface_dst, then check that umeyamaSimilarity recovers the
    // forward transform.
    const angle = -Math.PI / 12; // -15°
    const scale = 3.0; // face spans ~3× the 112-template width
    const a = scale * Math.cos(angle);
    const b = scale * Math.sin(angle);
    const tx = 350; // centre the face on the thumbnail
    const ty = 200;
    // Source landmarks live in source-image space.
    const src: Array<[number, number]> = ARCFACE_DST.map(
      ([x, y]) => [a * x - b * y + tx, b * x + a * y + ty] as [number, number],
    );
    // We want the transform that maps src → arcface_dst. That's the
    // inverse of the (a, b, tx, ty) we used to construct src.
    const forward = umeyamaSimilarity(src, ARCFACE_DST);
    const projected = applyAll(forward, src);
    for (let i = 0; i < ARCFACE_DST.length; i++) {
      expect(dist(projected[i]!, ARCFACE_DST[i]!)).toBeLessThan(1e-4);
    }
  });
});

describe('invertSimilarity', () => {
  it('inverts a composite transform exactly (round-trip identity)', () => {
    const s: Similarity2D = { a: 1.4, b: 0.3, tx: -7, ty: 11 };
    const inv = invertSimilarity(s);
    for (const [x, y] of [
      [0, 0],
      [10, 0],
      [0, 10],
      [3.14, -2.72],
    ] as Array<[number, number]>) {
      const [fx, fy] = applySimilarity(s, x, y);
      const [bx, by] = applySimilarity(inv, fx, fy);
      expect(bx).toBeCloseTo(x, 6);
      expect(by).toBeCloseTo(y, 6);
    }
  });

  it('rejects singular transform', () => {
    expect(() => invertSimilarity({ a: 0, b: 0, tx: 1, ty: 1 })).toThrow(/singular/);
  });
});
