/**
 * 2D similarity-transform math for face landmark alignment.
 *
 * Split out of `face-detector.ts` to keep that file under the 600-LOC
 * budget. Everything here is pure (no I/O, no globals) — the detector
 * imports `umeyamaSimilarity` + `invertSimilarity` + `sampleBilinear`
 * + `ARCFACE_DST` and composes them into the warp loop.
 *
 * The math here is load-bearing for embedding quality:
 *
 *   - Wrong `ARCFACE_DST` → embeddings drift off-distribution because
 *     every public ArcFace checkpoint was trained against this exact
 *     5-point template at 112×112.
 *   - Wrong sign correction in Umeyama → flipped/mirrored crops, which
 *     register as a different identity at typical recognizer thresholds.
 *
 * Tested directly by `face-detector.umeyama.test.ts` against golden cases
 * (identity, pure translation/scale/rotation, composite, ARCFACE_DST
 * round-trip, `invertSimilarity` round-trip).
 */

/**
 * InsightFace's canonical 5-point template (`arcface_dst`). Every public
 * ArcFace checkpoint — including R100 / R50 / R34 / MobileFaceNet — was
 * trained against this template at 112×112. Coordinates are in pixels on
 * the 112×112 output canvas; left eye, right eye, nose tip, left mouth
 * corner, right mouth corner.
 *
 * These exact numbers are load-bearing — they're the constants every
 * other InsightFace consumer uses (Python SDK, C++ SDK, MXNet reference
 * impl), and a 1px deviation here shifts the embedding off-distribution
 * enough to register as a different identity at typical thresholds.
 */
export const ARCFACE_DST: ReadonlyArray<readonly [number, number]> = [
  [38.2946, 51.6963], // left eye
  [73.5318, 51.5014], // right eye
  [56.0252, 71.7366], // nose
  [41.5493, 92.3655], // left mouth
  [70.7299, 92.2041], // right mouth
];

/**
 * A 2D similarity transform stored as its four free parameters.
 *
 *   [x']   [ a  -b ] [x]   [tx]
 *   [y'] = [ b   a ] [y] + [ty]
 *
 * The (a, b) form encodes uniform scale + rotation in two numbers — the
 * scale is `sqrt(a*a + b*b)` and the rotation angle is `atan2(b, a)`.
 * This is the shape Umeyama's method returns natively (scale × rotation
 * matrix + translation), and inverting it stays in the same family.
 */
export interface Similarity2D {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

/**
 * Umeyama (1991) closed-form least-squares similarity transform.
 *
 * Given N source points and N target points (N ≥ 2), returns the
 * similarity (uniform scale + rotation + translation) that minimises
 * the squared distance between target and (transform applied to
 * source). The returned matrix is a *proper* similarity — rotation
 * only, never reflection — because we detect the reflection case from
 * `det(USᵀ)` and flip the sign of the last column of `S` (the
 * Umeyama "sign trick").
 *
 * Implementation notes:
 *
 *   - We solve the 2D case in closed form via a 2×2 SVD. There's no
 *     dep on a linear algebra library — `svd2x2` below is ~30 lines
 *     and matches the reference algorithm in Press et al.
 *
 *   - The source must have non-zero variance (faces with all five
 *     landmarks collinear are excluded by SCRFD's training, but we
 *     guard against it anyway by checking the source covariance trace).
 *
 *   - We use the un-normalised scale (`uniform_scale = (Σ singular values × 1) /
 *     src_variance`) — Umeyama's paper uses `tr(DS)` over `σ_x²` where D
 *     is the diagonal of singular values and S is the sign-correction
 *     matrix. The "with_scaling" branch from the OpenCV reference.
 *
 * Pure function — no globals, no I/O. Exported so the test suite can
 * golden-value-check it against known inputs.
 */
export function umeyamaSimilarity(
  src: ReadonlyArray<readonly [number, number]>,
  dst: ReadonlyArray<readonly [number, number]>,
): Similarity2D {
  if (src.length !== dst.length) {
    throw new Error(
      `umeyamaSimilarity: src/dst length mismatch (src=${src.length}, dst=${dst.length})`,
    );
  }
  const N = src.length;
  if (N < 2) {
    throw new Error(`umeyamaSimilarity: need at least 2 point pairs, got ${N}`);
  }

  // Centroids.
  let srcCx = 0;
  let srcCy = 0;
  let dstCx = 0;
  let dstCy = 0;
  for (let i = 0; i < N; i++) {
    srcCx += src[i]![0];
    srcCy += src[i]![1];
    dstCx += dst[i]![0];
    dstCy += dst[i]![1];
  }
  srcCx /= N;
  srcCy /= N;
  dstCx /= N;
  dstCy /= N;

  // Variance of the source (used for the scale factor).
  // Cross-covariance Σ = (1/N) Σ_i (dst_i - dstC) (src_i - srcC)ᵀ — a 2×2
  // matrix flattened into four scalars.
  let srcVar = 0;
  let sigma00 = 0; // Σ[0,0]
  let sigma01 = 0; // Σ[0,1]
  let sigma10 = 0;
  let sigma11 = 0;
  for (let i = 0; i < N; i++) {
    const sx = src[i]![0] - srcCx;
    const sy = src[i]![1] - srcCy;
    const dx = dst[i]![0] - dstCx;
    const dy = dst[i]![1] - dstCy;
    srcVar += sx * sx + sy * sy;
    sigma00 += dx * sx;
    sigma01 += dx * sy;
    sigma10 += dy * sx;
    sigma11 += dy * sy;
  }
  srcVar /= N;
  sigma00 /= N;
  sigma01 /= N;
  sigma10 /= N;
  sigma11 /= N;

  if (srcVar <= 1e-12) {
    throw new Error(
      'umeyamaSimilarity: source points have zero variance (collinear or coincident)',
    );
  }

  // SVD of the 2×2 cross-covariance Σ = U D Vᵀ.
  const { U, D, V } = svd2x2(sigma00, sigma01, sigma10, sigma11);

  // Determinant sign trick: if det(U)·det(V) < 0 we'd get a reflection.
  // Flip the sign of the smallest singular value's column to force a
  // proper rotation. For 2×2 this is just one boolean.
  const detU = U[0]! * U[3]! - U[1]! * U[2]!;
  const detV = V[0]! * V[3]! - V[1]! * V[2]!;
  // S is a 2×2 diagonal in Umeyama's formulation: identity for the proper
  // case, diag(1, -1) for the reflection-fixup case.
  const sLast = detU * detV < 0 ? -1 : 1;
  const Smat = [1, 0, 0, sLast];

  // R = U · S · Vᵀ. S is diagonal so US is just U with its second column
  // multiplied by `sLast`. Vᵀ is V transposed.
  const US = [U[0]! * Smat[0]!, U[1]! * Smat[3]!, U[2]! * Smat[0]!, U[3]! * Smat[3]!];
  const VT = [V[0]!, V[2]!, V[1]!, V[3]!];
  const R = [
    US[0]! * VT[0]! + US[1]! * VT[2]!,
    US[0]! * VT[1]! + US[1]! * VT[3]!,
    US[2]! * VT[0]! + US[3]! * VT[2]!,
    US[2]! * VT[1]! + US[3]! * VT[3]!,
  ];

  // Scale: (1 / src_var) · trace(D · S) — i.e. (D[0] * S[0] + D[1] * S[3]) / src_var.
  const scale = (D[0]! * Smat[0]! + D[1]! * Smat[3]!) / srcVar;

  // Rotation+scale matrix M = scale · R. For a proper rotation the matrix
  // has the (a, -b; b, a) shape — we read a from R[0,0] and b from R[1,0]
  // and trust the sign-correction step above to have produced that
  // structure. Numerical noise from the 2×2 SVD can introduce sub-ULP
  // deviations from the perfect skew-symmetric form; ignoring them keeps
  // the warp continuous under small landmark perturbations.
  const a = scale * R[0]!;
  const b = scale * R[2]!;
  // Translation: dstC - M · srcC.
  const tx = dstCx - (a * srcCx - b * srcCy);
  const ty = dstCy - (b * srcCx + a * srcCy);

  return { a, b, tx, ty };
}

/**
 * 2×2 SVD. Returns U, V (row-major 2×2) and D (the two singular values
 * in descending order).
 *
 * Closed-form solution — there are several equivalent derivations; this
 * one builds the singular values from the symmetric part of M·Mᵀ, then
 * recovers U and V by rotating M onto its diagonal form. Stable enough
 * for the Umeyama use case (well-conditioned 2×2 covariances from a
 * 5-point face landmark set).
 */
function svd2x2(
  m00: number,
  m01: number,
  m10: number,
  m11: number,
): { U: number[]; D: number[]; V: number[] } {
  // M Mᵀ — symmetric 2×2 with entries (a, c; c, b).
  const a = m00 * m00 + m01 * m01;
  const b = m10 * m10 + m11 * m11;
  const c = m00 * m10 + m01 * m11;
  // Eigenvalues of M Mᵀ = squared singular values.
  //   λ = (a + b ± sqrt((a-b)² + 4c²)) / 2
  const trace = a + b;
  const det = a * b - c * c;
  const discriminant = Math.max(0, (trace * trace) / 4 - det);
  const root = Math.sqrt(discriminant);
  let lambda1 = trace / 2 + root;
  let lambda2 = trace / 2 - root;
  // Numerical floor — negative eigenvalues are noise from a (near-)rank-1 input.
  if (lambda1 < 0) lambda1 = 0;
  if (lambda2 < 0) lambda2 = 0;
  const sigma1 = Math.sqrt(lambda1);
  const sigma2 = Math.sqrt(lambda2);

  // U: eigenvectors of M Mᵀ via the 2×2 closed form.
  //   tan(2θ) = 2c / (a - b)
  // We use atan2 so the branch is unambiguous.
  const u_theta = 0.5 * Math.atan2(2 * c, a - b);
  const cu = Math.cos(u_theta);
  const su = Math.sin(u_theta);
  // U row-major, columns = u0 (cu, su), u1 (-su, cu).
  const U = [cu, -su, su, cu];

  // V columns come from v_i = (1/σ_i) · Mᵀ · u_i — derived from M = U Σ Vᵀ.
  // When σ_i ≈ 0 we pick the perpendicular direction (right-hand rule) so
  // V is still a proper rotation — the corresponding singular value is
  // zero so the column doesn't contribute anyway.
  const u0x = U[0]!;
  const u0y = U[2]!;
  const u1x = U[1]!;
  const u1y = U[3]!;
  let v0x: number;
  let v0y: number;
  let v1x: number;
  let v1y: number;
  if (sigma1 > 1e-12) {
    v0x = (m00 * u0x + m10 * u0y) / sigma1;
    v0y = (m01 * u0x + m11 * u0y) / sigma1;
  } else {
    v0x = 1;
    v0y = 0;
  }
  if (sigma2 > 1e-12) {
    v1x = (m00 * u1x + m10 * u1y) / sigma2;
    v1y = (m01 * u1x + m11 * u1y) / sigma2;
  } else {
    v1x = -v0y;
    v1y = v0x;
  }
  // V row-major, columns are v0 and v1.
  const V = [v0x, v1x, v0y, v1y];

  return { U, D: [sigma1, sigma2], V };
}

/**
 * Invert a 2D similarity transform. Given M(x) = Ax + t with rotation+
 * scale `A = [[a,-b],[b,a]]`, the inverse is M⁻¹(y) = A⁻¹(y - t),
 * and A⁻¹ is itself a rotation+scale with the conjugate complex
 * (a/(a²+b²), -b/(a²+b²)). Exposed for testing.
 */
export function invertSimilarity(s: Similarity2D): Similarity2D {
  const denom = s.a * s.a + s.b * s.b;
  if (denom < 1e-18) {
    throw new Error('invertSimilarity: singular transform (a² + b² = 0)');
  }
  const a = s.a / denom;
  const b = -s.b / denom;
  // M(x) = A x + t → M⁻¹(y) = A⁻¹ y + (-A⁻¹ t)
  const tx = -(a * s.tx - b * s.ty);
  const ty = -(b * s.tx + a * s.ty);
  return { a, b, tx, ty };
}

/** Apply a similarity transform to a single (x, y) point. Used by the
 * test suite to verify round-trip behaviour without needing the warper. */
export function applySimilarity(s: Similarity2D, x: number, y: number): [number, number] {
  return [s.a * x - s.b * y + s.tx, s.b * x + s.a * y + s.ty];
}

/**
 * Bilinear sampler on an interleaved RGB plane. Out-of-bounds reads
 * clamp to the edge — this matches how the original ArcFace / InsightFace
 * reference impls handle pixels past the image boundary, and avoids
 * producing 0-valued "background" pixels that would distort the
 * embedding for faces near the image edge.
 *
 * Returns a `[r, g, b]` tuple in `[0,255]` so the caller can apply the
 * recognizer's `(px - 127.5) / 128.0` normalisation uniformly.
 */
export function sampleBilinear(
  rgb: Buffer,
  W: number,
  H: number,
  x: number,
  y: number,
): [number, number, number] {
  // Clamp to [0, W-1] × [0, H-1].
  const cx = x < 0 ? 0 : x > W - 1 ? W - 1 : x;
  const cy = y < 0 ? 0 : y > H - 1 ? H - 1 : y;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = x0 + 1 >= W ? W - 1 : x0 + 1;
  const y1 = y0 + 1 >= H ? H - 1 : y0 + 1;
  const fx = cx - x0;
  const fy = cy - y0;

  // Stride for interleaved RGB.
  const o00 = (y0 * W + x0) * 3;
  const o10 = (y0 * W + x1) * 3;
  const o01 = (y1 * W + x0) * 3;
  const o11 = (y1 * W + x1) * 3;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  const r = rgb[o00]! * w00 + rgb[o10]! * w10 + rgb[o01]! * w01 + rgb[o11]! * w11;
  const g = rgb[o00 + 1]! * w00 + rgb[o10 + 1]! * w10 + rgb[o01 + 1]! * w01 + rgb[o11 + 1]! * w11;
  const b = rgb[o00 + 2]! * w00 + rgb[o10 + 2]! * w10 + rgb[o01 + 2]! * w01 + rgb[o11 + 2]! * w11;
  return [r, g, b];
}
