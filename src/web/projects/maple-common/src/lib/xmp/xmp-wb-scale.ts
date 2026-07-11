// xmp-wb-scale.ts — WB slider-scale version resolution (#1780/#1875/#1893/#1894).
// Split out of `xmp-parser.service.ts` for the 600-line file budget, the
// same split the Swift side made in #1780 (`XMPSerialization+Attrs.swift`).
//
// Resolution rule (mirrors raw-core's `xmp::parse` and the Swift
// `XMPParser`): an explicit `papp:WbScaleVersion` stamp wins; otherwise a
// document carrying the Maple `papp:` namespace (declaration or attribute
// — every Maple writer declares it unconditionally; the PREFIX is the
// discriminator because the three Maple writers historically bound `papp`
// to different URIs) AND an explicit authored `crs:Temperature`/`crs:Tint`
// predates the versioning (pre-#1756 scale, 1). Everything else — no
// `papp:` namespace at all (ACR/Lightroom-authored, expressed in ACR's own
// convention, which V5 (#1894) evaluates on directly — ACR derives its
// displayed pair from exactly the Robertson isotherm table `wb-dng-
// temperature.ts` ports) or no authored WB (nothing to convert) — is 5.
//
// V2/V3/V4 → V5 load-normalization (#1894): each legacy scale's tint axis
// and/or magnitude differs from V5's Robertson-native convention, AND the
// legacy scales evaluate on a different locus (Hernández-Andrés daylight/
// blackbody, not Robertson) — so the authored pair converts JOINTLY
// (temperature AND tint both move) via `authoredPairToV5`, not a scalar
// tint multiply. Even a temperature-only authored value moves slightly in
// both components: the two loci agree on direction but not exactly on
// magnitude, so re-expressing the same physical chromaticity in V5's
// coordinates nudges the temperature too (e.g. legacy (6500, 0) reads back
// ≈ (6454, +10.6) — the same physical point, named in ACR's coordinates).
// The caller applies `authoredPairToV5` to the parsed
// `crs:Temperature`/`crs:Tint` pair (after the attribute walk) and stores
// the model as version 5, so the in-memory model and every re-serialize
// are uniformly V5. V1 deliberately does NOT load-normalize — its
// conversion needs the image's calibration frame, so raw-core converts it
// at develop and the sidecar round-trips as V1.

import { xyToTempTint } from './wb-dng-temperature';

/** Legacy (V2/V3, 1e-4 uv per unit) → V4 (`kTintScale`, 1/3000 uv per
 * unit) tint multiplier — mirrors raw-core's `TINT_SCALE_V3_TO_V4`. Also
 * the magnitude term `authoredPairToV5` applies for V1/V2/V3 before
 * evaluating the legacy locus map (#1893/#1894). Module-local: consumers
 * act through `authoredPairToV5`, never on the raw constant. */
const TINT_SCALE_V3_TO_V4 = 0.3;

/**
 * Scale factor (uv units per tint unit) for the perpendicular-to-locus
 * tint displacement in the LEGACY (pre-#1894) value mapping — ACR's own
 * `dng_temperature.cpp` `kTintScale` — mirrors raw-core's `TINT_UV_SCALE`.
 */
const TINT_UV_SCALE = 1.0 / 3000.0;

// ── Legacy (≤V4) Hernández-Andrés locus map ─────────────────────────────
//
// Faithful port of raw-core's `stages::white_balance` value mapping:
// `cct_to_xy` (Hernández-Andrés et al. 1999 daylight/blackbody polynomial),
// `xy_to_uv`/`uv_to_xy` (CIE 1960 UCS), and the perpendicular-tint-
// displacement machinery (`apply_tint_perpendicular`,
// `tint_perpendicular_axis`, `locus_tangent_uv`). This is Maple's PRE-#1894
// value mapping, kept ONLY so authored ≤V4 pairs can be re-expressed
// through the physical chromaticity they encoded when written
// (`authoredPairToV5` below) — it is not evaluated by any live V5 render
// path (that's `wb-dng-temperature.ts`'s Robertson mapping).

/**
 * CCT (Kelvin) → CIE xy chromaticity on the Planckian (blackbody) locus,
 * via Hernández-Andrés et al. 1999. Valid range 1667K–25000K; clamped to
 * [2000K, 25000K] — mirrors raw-core's `cct_to_xy`.
 */
function cctToXy(cctIn: number): [number, number] {
  const t = Math.min(Math.max(cctIn, 2000.0), 25000.0);
  const x =
    t <= 4000.0
      ? 0.17991 + 877.6956 / t - 234358.9 / (t * t) - 266123900.0 / (t * t * t)
      : 0.24039 + 222.6347 / t + 2107037.9 / (t * t) - 3025846900.0 / (t * t * t);
  const y = -3.0 * x * x + 2.87 * x - 0.275;
  return [x, y];
}

/** CIE xy → CIE 1960 UCS (u, v), the legacy map's metric — mirrors
 * raw-core's `white_balance::xy_to_uv`. */
function legacyXyToUv(x: number, y: number): [number, number] {
  const denom = -2.0 * x + 12.0 * y + 3.0;
  return [(4.0 * x) / denom, (6.0 * y) / denom];
}

/** CIE 1960 UCS (u, v) → CIE xy — exact inverse of `legacyXyToUv`,
 * mirrors raw-core's `white_balance::uv_to_xy`. */
function legacyUvToXy(u: number, v: number): [number, number] {
  const denom = 2.0 * u - 8.0 * v + 4.0;
  return [(3.0 * u) / denom, (2.0 * v) / denom];
}

/**
 * Unit tangent-to-locus direction in CIE 1960 uv space at `cct`, via
 * central finite difference at `cct ± 50 K`, center-clamped to
 * [2000, 25000] before stepping — mirrors raw-core's `locus_tangent_uv`.
 */
function locusTangentUv(cct: number): [number, number] {
  const deltaK = 50.0;
  const center = Math.min(Math.max(cct, 2000.0), 25000.0);
  const [xp, yp] = cctToXy(Math.min(center + deltaK, 25000.0));
  const [xm, ym] = cctToXy(Math.max(center - deltaK, 2000.0));
  const [up, vp] = legacyXyToUv(xp, yp);
  const [um, vm] = legacyXyToUv(xm, ym);
  const rawDu = up - um;
  const rawDv = vp - vm;
  const len = Math.max(Math.sqrt(rawDu * rawDu + rawDv * rawDv), 1e-10);
  return [rawDu / len, rawDv / len];
}

/**
 * Unit perpendicular-to-locus direction in CIE 1960 uv space at `cct` —
 * mirrors raw-core's `tint_perpendicular_axis`. `tintSignPositiveV` selects
 * which of the two 90°-rotated candidates to use; `authoredPairToV5` always
 * passes `true` (the every-model-facing-path convention, #1875).
 */
function tintPerpendicularAxis(cct: number, tintSignPositiveV: boolean): [number, number] {
  const [du, dv] = locusTangentUv(cct);
  return tintSignPositiveV ? [dv, -du] : [-dv, du];
}

/**
 * Apply a tint displacement perpendicular to the Planckian locus in CIE
 * 1960 uv space — mirrors raw-core's `apply_tint_perpendicular`.
 */
function applyTintPerpendicular(
  x: number,
  y: number,
  cct: number,
  tint: number,
  tintSignPositiveV: boolean,
): [number, number] {
  const [perpU, perpV] = tintPerpendicularAxis(cct, tintSignPositiveV);
  const [u0, v0] = legacyXyToUv(x, y);
  const displacement = tint * TINT_UV_SCALE;
  return legacyUvToXy(u0 + displacement * perpU, v0 + displacement * perpV);
}

/**
 * The pre-#1894 (≤ V4) forward map — Hernández-Andrés daylight locus +
 * perpendicular uv displacement at the version's tint magnitude. Kept ONLY
 * so values authored under the legacy scales can be re-expressed through
 * the physical chromaticity they encoded (`authoredPairToV5`); mirrors
 * raw-core's `legacy_slider_source_xy`.
 */
function legacySliderSourceXy(temperature: number, tint: number): [number, number] {
  const [x, y] = cctToXy(temperature);
  return applyTintPerpendicular(x, y, temperature, tint, true);
}

/**
 * Rescale an authored tint into the legacy map's `kTintScale` magnitude,
 * per the version's axis/scale — mirrors the `match` arm in raw-core's
 * `authored_pair_to_v5` (V5 is handled by the caller, not here).
 */
function legacyTintForVersion(tint: number, version: number): number {
  if (version === 2) return -tint * TINT_SCALE_V3_TO_V4;
  if (version === 4) return tint;
  // V1 | V3
  return tint * TINT_SCALE_V3_TO_V4;
}

/**
 * Re-express an explicitly-authored `(temperature, tint)` pair in the
 * current (V5, #1894) Robertson value mapping, preserving the physical
 * chromaticity it encoded when written. Faithful port of raw-core's
 * `authored_pair_to_v5`:
 *
 * - **V1/V3** — ACR-direction axis at the legacy 1e-4 uv-per-unit scale:
 *   rescale the tint by `TINT_SCALE_V3_TO_V4` (0.3), evaluate the legacy
 *   (Hernández-Andrés + perpendicular) map, invert through Robertson.
 * - **V2** — the inverted-axis legacy scale: negate AND rescale, then the
 *   same xy round-trip.
 * - **V4** — ACR magnitude but the legacy locus map (#1893, never in a
 *   released build): straight xy round-trip.
 * - **V5** — Robertson-native: passes through.
 *
 * The conversion transforms the PAIR jointly — the legacy map's locus is
 * the daylight locus while Robertson's is blackbody, so even a
 * temperature-only authored value moves slightly in both components.
 */
export function authoredPairToV5(
  temperature: number,
  tint: number,
  version: number,
): [number, number] {
  if (version === 5) return [temperature, tint];
  const legacyTint = legacyTintForVersion(tint, version);
  const [x, y] = legacySliderSourceXy(temperature, legacyTint);
  return xyToTempTint(x, y);
}

// ── Version-stamp resolution ─────────────────────────────────────────────

export interface WbScaleResolution {
  /** The version to store on the model (never 2, 3, or 4 — all normalize to 5). */
  modelVersion: number;
  /**
   * The version an authored `(temperature, tint)` pair was actually
   * written in (1–5) — distinct from `modelVersion` for V2/V3/V4, which
   * normalize `modelVersion` to 5 but need their own identity preserved so
   * the caller passes the RIGHT version into `authoredPairToV5`.
   */
  sourceVersion: number;
}

/** Parse a `papp:WbScaleVersion` stamp value, or `undefined` if absent/unknown. */
function parseWbScaleStamp(raw: string | null): number | undefined {
  if (raw === '1') return 1;
  if (raw === '2') return 2;
  if (raw === '3') return 3;
  if (raw === '4') return 4;
  if (raw === '5') return 5;
  return undefined;
}

/**
 * Resolve the WB scale version for a parsed `rdf:Description` element.
 * `sawPappAnywhere` is the document-level Maple-authorship flag (any
 * element carrying `xmlns:papp` or a `papp:`-prefixed attribute).
 */
export function resolveWbScaleVersion(desc: Element, sawPappAnywhere: boolean): WbScaleResolution {
  const sawExplicitWb =
    desc.getAttribute('crs:Temperature') !== null || desc.getAttribute('crs:Tint') !== null;
  const stamp = parseWbScaleStamp(desc.getAttribute('papp:WbScaleVersion'));
  const sourceVersion = stamp ?? (sawPappAnywhere && sawExplicitWb ? 1 : 5);
  return {
    modelVersion: sourceVersion === 1 ? 1 : 5,
    sourceVersion,
  };
}

/**
 * WB preset a parsed model should carry when the sidecar authored a
 * `crs:Temperature`/`crs:Tint` but no `crs:WhiteBalance` attribute: that is
 * a Custom WB — the same rule raw-core's parser encodes via its
 * `temperature_seen`/`tint_seen` flags. Recording 'Custom' keeps the
 * serializer's As-Shot gate (#1892) from dropping those authored values on
 * the next save (sidecars written before the gate never stamped a preset
 * alongside slider edits). Returns `undefined` when nothing should change:
 * an explicit preset was parsed, or no WB fields were authored.
 */
export function inferredWbPresetForAuthoredPair(
  parsedPreset: string | undefined,
  appliedModelKeys: ReadonlySet<string>,
): 'Custom' | undefined {
  const authoredPair = appliedModelKeys.has('temperature') || appliedModelKeys.has('tint');
  return parsedPreset === undefined && authoredPair ? 'Custom' : undefined;
}
