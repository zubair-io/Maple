// xmp-local-adjustments-brush.ts — the `papp:BrushCorrections` XMP codecs
// (#360), split from `xmp-local-adjustments.ts` (at its file budget): the
// `Mask/Paint` leaf parser + emitter and the scalar codecs the dab series
// shares with the other writers. `docs/xmp-canonical-format.md`
// § "Brush masks" is the contract; `raw-core/src/xmp/
// local_adjustments/` is the reference implementation this mirrors
// byte-for-byte on the write side and semantically on the read side.

import { BRUSH_VERSION } from '../generated/local-mask-wire.generated';
import type { BrushDab, BrushMask, LeafMask } from '../models/local-adjustment';
import { attrOf } from './xmp-dom-utils';

const DECIMAL_TOKEN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** The `crs:What` a paint leaf carries. */
export const MASK_WHAT_PAINT = 'Mask/Paint';

/** Exactly raw-core's `fmt_mask_coord`: 6 decimals, trailing zeros trimmed. */
export const maskCoord = (value: number): string => {
  const rounded = (Math.sign(value) * Math.round(Math.abs(value) * 1e6)) / 1e6;
  return rounded === 0 ? '0' : rounded.toFixed(6).replace(/\.?0+$/, '');
};

/**
 * The `FRACTION_SCALED` keys ride Adobe's ±1 scale, so the canonical
 * two-decimal codec (`numericSerializer`) would quantise Maple's ±100 slider
 * to whole units and drift a fractional value on every round-trip (−42.5 →
 * "-0.43" → −43). Four decimals keep two decimals of the ±100 value —
 * mirrors raw-core's `fmt4` and Swift's `fmtNum4` so all four writers stay
 * byte-identical (#3400, #3407). Rounded away from zero like both of those —
 * `Math.round` alone rounds a negative tie toward +∞ (−2.5 → −2), which
 * would split the writers at an exact four-decimal midpoint.
 */
export const fractionSerializer = (v: number): string =>
  ((Math.sign(v) * Math.round(Math.abs(v) * 10_000)) / 10_000).toString();

/**
 * Exactly raw-core's `escape_attr` (`&`, `<`, `"` — and nothing else, so the
 * bytes stay identical): the two free-text recipe fields are the only place
 * a `crs:`/`papp:` attribute value here could legally carry one of those.
 */
export const escapeRecipeAttr = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

/**
 * A `Mask/Paint` leaf (#360): `papp:BrushVersion`, the dab series in
 * `papp:Dabs` — six whitespace-separated tokens per dab (`x y radius feather
 * weight erase`, erase exactly `0`/`1`) — plus `papp:BrushDigest`, the
 * FNV-1a content hash (`brushDigest`). A missing `papp:Dabs` is an empty
 * stroke (weight 0); an unknown version or a malformed series drops the
 * correction (raw-core hard-errors on the latter; this reader is tolerant
 * like its siblings).
 */
export function parseBrushLeaf(leaf: Element): LeafMask | undefined {
  if (attrOf(leaf, ['papp:BrushVersion']) !== String(BRUSH_VERSION)) return undefined;
  const series = attrOf(leaf, ['papp:Dabs']);
  const tokens = series === null || series.trim().length === 0 ? [] : series.trim().split(/\s+/);
  if (tokens.length % 6 !== 0) return undefined;
  const dabs: BrushDab[] = [];
  for (let i = 0; i < tokens.length; i += 6) {
    const fields = tokens.slice(i, i + 5);
    // raw-core's decimal float grammar: `Number` also accepts hex and blanks.
    if (!fields.every((token) => DECIMAL_TOKEN.test(token))) return undefined;
    const nums = fields.map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return undefined;
    const [x, y, radius, feather, weight] = nums as [number, number, number, number, number];
    const erase = tokens[i + 5];
    if (erase !== '0' && erase !== '1') return undefined;
    dabs.push({ center: { x, y }, radius, feather, weight, erase: erase === '1' });
  }
  return {
    kind: 'brush',
    dabs,
    digest: attrOf(leaf, ['papp:BrushDigest']) ?? '',
    // The sidecar never carries a raster id — the render worker's registry
    // resolves the digest at render time (`docs/xmp-canonical-format.md`).
    rasterId: 0,
  };
}

/**
 * The `papp:Dabs` attribute value (#360): six whitespace-separated tokens per
 * dab — `x y radius feather weight erase` — positions/radius in the
 * 6-decimal mask-coordinate format, feather/weight in 4 decimals (the
 * rasterizer quantizes to R8), erase as `0`/`1`. Dabs with a non-finite
 * field are dropped, mirroring raw-core's writer.
 */
function dabSeries(dabs: readonly BrushDab[]): string {
  return dabs
    .filter((d) =>
      [d.center.x, d.center.y, d.radius, d.feather, d.weight].every((v) => Number.isFinite(v)),
    )
    .map((d) =>
      [
        maskCoord(d.center.x),
        maskCoord(d.center.y),
        maskCoord(d.radius),
        fractionSerializer(d.feather),
        fractionSerializer(d.weight),
        d.erase ? '1' : '0',
      ].join(' '),
    )
    .join(' ');
}

export function brushLines(mask: BrushMask, indent: string): string[] {
  // `rasterId` is never written: it is an in-process handle, re-resolved on load.
  const lines = [
    `${indent}<rdf:li`,
    `${indent}  crs:What="${MASK_WHAT_PAINT}"`,
    `${indent}  crs:MaskValue="1"`,
    `${indent}  papp:BrushVersion="${BRUSH_VERSION}"`,
  ];
  const series = dabSeries(mask.dabs);
  if (series.length > 0) lines.push(`${indent}  papp:Dabs="${series}"`);
  if (mask.digest.length > 0)
    lines.push(`${indent}  papp:BrushDigest="${escapeRecipeAttr(mask.digest)}"`);
  // The last attribute line carries the self-closing `/>`.
  lines[lines.length - 1] += '/>';
  return lines;
}
