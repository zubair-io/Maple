// CIEDE2000 ΔE — Bruce Lindbloom reference implementation.
// Plan 3 M2.1 — used by the test page and pipeline.spec.ts.
//
// Inputs are sRGB Uint8ClampedArray (RGBA8 packed). Output is mean,
// p95, max ΔE₀₀ across all pixels, plus per-channel bias on the
// gamma-encoded sRGB byte values (matches src/scripts/compare_images.py
// numerics within fp64 precision).

export interface DeltaEStats {
  mean: number;
  p95: number;
  max: number;
  /** Per-channel mean (cand - ref) on [0, 1] sRGB-encoded values. */
  biasR: number;
  biasG: number;
  biasB: number;
  nPixels: number;
}

function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function linearToXYZ(r: number, g: number, b: number): [number, number, number] {
  // sRGB D65 -> XYZ (Rec.709 primaries).
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    0.0193339 * r + 0.119192 * g + 0.9503041 * b,
  ];
}

function xyzToLab(x: number, y: number, z: number): [number, number, number] {
  // D65 reference white.
  const xn = 0.95047;
  const yn = 1.0;
  const zn = 1.08883;
  const f = (t: number): number =>
    t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;
  const fx = f(x / xn);
  const fy = f(y / yn);
  const fz = f(z / zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function pixelToLab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const [x, y, z] = linearToXYZ(lr, lg, lb);
  return xyzToLab(x, y, z);
}

function deltaE2000(
  l1: number,
  a1: number,
  b1: number,
  l2: number,
  a2: number,
  b2: number,
): number {
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G =
    0.5 *
    (1 - Math.sqrt(Math.pow(Cbar, 7) / (Math.pow(Cbar, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = (Math.atan2(b1, a1p) * 180) / Math.PI;
  const h2p = (Math.atan2(b2, a2p) * 180) / Math.PI;
  const h1pn = h1p < 0 ? h1p + 360 : h1p;
  const h2pn = h2p < 0 ? h2p + 360 : h2p;
  const dLp = l2 - l1;
  const dCp = C2p - C1p;
  let dhp: number;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2pn - h1pn) <= 180) dhp = h2pn - h1pn;
  else if (h2pn - h1pn > 180) dhp = h2pn - h1pn - 360;
  else dhp = h2pn - h1pn + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);
  const Lp = (l1 + l2) / 2;
  const Cp = (C1p + C2p) / 2;
  let hp: number;
  if (C1p * C2p === 0) hp = h1pn + h2pn;
  else if (Math.abs(h1pn - h2pn) <= 180) hp = (h1pn + h2pn) / 2;
  else if (h1pn + h2pn < 360) hp = (h1pn + h2pn + 360) / 2;
  else hp = (h1pn + h2pn - 360) / 2;
  const T =
    1 -
    0.17 * Math.cos(((hp - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * hp * Math.PI) / 180) +
    0.32 * Math.cos(((3 * hp + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * hp - 63) * Math.PI) / 180);
  const dTheta = 30 * Math.exp(-Math.pow((hp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cp, 7) / (Math.pow(Cp, 7) + Math.pow(25, 7)));
  const Sl =
    1 + (0.015 * Math.pow(Lp - 50, 2)) / Math.sqrt(20 + Math.pow(Lp - 50, 2));
  const Sc = 1 + 0.045 * Cp;
  const Sh = 1 + 0.015 * Cp * T;
  const Rt = -Math.sin((2 * dTheta * Math.PI) / 180) * Rc;
  return Math.sqrt(
    Math.pow(dLp / Sl, 2) +
      Math.pow(dCp / Sc, 2) +
      Math.pow(dHp / Sh, 2) +
      Rt * (dCp / Sc) * (dHp / Sh),
  );
}

export function computeDeltaEStats(
  candidate: Uint8ClampedArray,
  reference: Uint8ClampedArray,
): DeltaEStats {
  if (candidate.length !== reference.length) {
    throw new Error(
      `delta-e: length mismatch ${candidate.length} vs ${reference.length}`,
    );
  }
  const n = candidate.length / 4;
  const dEs: number[] = new Array(n);
  let biasR = 0;
  let biasG = 0;
  let biasB = 0;
  for (let i = 0; i < n; i += 1) {
    const j = i * 4;
    const cR = candidate[j];
    const cG = candidate[j + 1];
    const cB = candidate[j + 2];
    const rR = reference[j];
    const rG = reference[j + 1];
    const rB = reference[j + 2];
    const [l1, a1, b1] = pixelToLab(cR, cG, cB);
    const [l2, a2, b2] = pixelToLab(rR, rG, rB);
    dEs[i] = deltaE2000(l1, a1, b1, l2, a2, b2);
    biasR += (cR - rR) / 255;
    biasG += (cG - rG) / 255;
    biasB += (cB - rB) / 255;
  }
  dEs.sort((a, b) => a - b);
  const mean = dEs.reduce((s, x) => s + x, 0) / n;
  const p95 = dEs[Math.min(n - 1, Math.floor(n * 0.95))];
  const max = dEs[n - 1];
  return {
    mean,
    p95,
    max,
    biasR: biasR / n,
    biasG: biasG / n,
    biasB: biasB / n,
    nPixels: n,
  };
}
