// tool-sub-param.ts — multi-param tool pills (#1108, spec §10.0).
//
// A tool may declare an ORDERED list of sub-parameters. Arming a
// multi-param tool surfaces a compact chip selector above the drag bar
// (SubParamRowComponent); the drag bar, value chip, fine mode and undo
// semantics then act on the armed (tool, subParam) pair. Single-param
// tools declare no entry here and keep the tool-model mapping verbatim.
//
// Mirrors the Apple `ToolSubParam` in
// `src/apple/Packages/MapleCore/Sources/MapleCore/Editor/ToolSubParam.swift`.
//
// Ranges and defaults are sourced from the GENERATED schema tables
// (`ADJUSTMENT_RANGES` / `defaultGeneratedAdjustmentModel`) so sub-params
// cannot drift from raw-core — same rule as tool-model.ts (#953).

import {
  ADJUSTMENT_RANGES,
  defaultGeneratedAdjustmentModel,
  type AdjustmentModel,
} from '../models/adjustment-model';
import type { ToolId } from './tool-model';

/** Numeric schema fields — exactly the keys carrying a generated range. */
export type SubParamField = keyof typeof ADJUSTMENT_RANGES & keyof AdjustmentModel;

/**
 * Internal `[-100, +100]` ↔ display mapping family for a sub-param.
 *
 * - `linear`: affine `lo..hi` onto `-100..+100` — the noise / colorNR
 *   layout, where the marker position mirrors the position in the range.
 * - `anchored`: pivot at the field's canonical default — internal 0 IS
 *   the default and ±100 are the range ends (the temp / sharpen-amount
 *   layout). Requires `lo < default < hi`.
 */
export type SubParamMapping = 'linear' | 'anchored';

export interface ToolSubParam {
  /** Stable id, unique within the tool (used in testids + session memory). */
  readonly id: string;
  /** Chip label; the value chip shows it uppercased. */
  readonly label: string;
  /** AdjustmentModel field this sub-param reads/writes. */
  readonly field: SubParamField;
  readonly mapping: SubParamMapping;
  /** Value-chip fraction digits (radius is sub-integer: "1.0"). */
  readonly decimals: number;
  /**
   * DECODE-PRODUCT field: writing it invalidates the decoded buffer, so the
   * model write is held until the gesture ENDS instead of firing per tick
   * (spec § 3.1 / § 3.2 — "the UI commits on release, not per tick").
   *
   * The live session's prefix model keeps these fields (`stripped_prefix_model`
   * in raw-wasm, `stripAppleGPUStages` on Apple), so a per-tick write would
   * re-develop — seconds of BM3D — on every pointer sample. Absent/`false` for
   * the GPU-chain sliders, which stay on the zero-alloc per-tick path.
   */
  readonly commitOnRelease?: boolean;
}

// Sub-param catalogs for the multi-param pills. §10.0: the Noise pill's
// Deep (BM3D, §3.2) and Prefilter (§3.1) tiers joined at #1153 — data-only,
// plus the `commitOnRelease` flag their decode-product placement forces.
// Vignette joined
// at #1109, grain at #1110, split tone at #1111 (Balance leads — the
// schema-declared primary drag-bar field). HSL joined at #1112 with 24
// sub-params across 3 rows (Hue/Sat/Lum × 8 bands); Hue Red leads.
const SUB_PARAMS: Partial<Record<ToolId, readonly ToolSubParam[]>> = {
  hsl: [
    // Hue row (bands Red → Magenta)
    { id: 'hueRed', label: 'H Red', field: 'hueAdjustmentRed', mapping: 'anchored', decimals: 0 },
    {
      id: 'hueOrange',
      label: 'H Orange',
      field: 'hueAdjustmentOrange',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'hueYellow',
      label: 'H Yellow',
      field: 'hueAdjustmentYellow',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'hueGreen',
      label: 'H Green',
      field: 'hueAdjustmentGreen',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'hueAqua',
      label: 'H Aqua',
      field: 'hueAdjustmentAqua',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'hueBlue',
      label: 'H Blue',
      field: 'hueAdjustmentBlue',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'huePurple',
      label: 'H Purple',
      field: 'hueAdjustmentPurple',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'hueMagenta',
      label: 'H Magenta',
      field: 'hueAdjustmentMagenta',
      mapping: 'anchored',
      decimals: 0,
    },
    // Saturation row
    {
      id: 'satRed',
      label: 'S Red',
      field: 'saturationAdjustmentRed',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'satOrange',
      label: 'S Orange',
      field: 'saturationAdjustmentOrange',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'satYellow',
      label: 'S Yellow',
      field: 'saturationAdjustmentYellow',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'satGreen',
      label: 'S Green',
      field: 'saturationAdjustmentGreen',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'satAqua',
      label: 'S Aqua',
      field: 'saturationAdjustmentAqua',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'satBlue',
      label: 'S Blue',
      field: 'saturationAdjustmentBlue',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'satPurple',
      label: 'S Purple',
      field: 'saturationAdjustmentPurple',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'satMagenta',
      label: 'S Magenta',
      field: 'saturationAdjustmentMagenta',
      mapping: 'anchored',
      decimals: 0,
    },
    // Luminance row
    {
      id: 'lumRed',
      label: 'L Red',
      field: 'luminanceAdjustmentRed',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'lumOrange',
      label: 'L Orange',
      field: 'luminanceAdjustmentOrange',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'lumYellow',
      label: 'L Yellow',
      field: 'luminanceAdjustmentYellow',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'lumGreen',
      label: 'L Green',
      field: 'luminanceAdjustmentGreen',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'lumAqua',
      label: 'L Aqua',
      field: 'luminanceAdjustmentAqua',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'lumBlue',
      label: 'L Blue',
      field: 'luminanceAdjustmentBlue',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'lumPurple',
      label: 'L Purple',
      field: 'luminanceAdjustmentPurple',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'lumMagenta',
      label: 'L Magenta',
      field: 'luminanceAdjustmentMagenta',
      mapping: 'anchored',
      decimals: 0,
    },
  ],
  vignette: [
    { id: 'amount', label: 'Amount', field: 'vignetteAmount', mapping: 'anchored', decimals: 0 },
    { id: 'feather', label: 'Feather', field: 'vignetteFeather', mapping: 'linear', decimals: 0 },
  ],
  grain: [
    { id: 'amount', label: 'Amount', field: 'grainAmount', mapping: 'linear', decimals: 0 },
    { id: 'size', label: 'Size', field: 'grainSize', mapping: 'linear', decimals: 0 },
    {
      id: 'roughness',
      label: 'Roughness',
      field: 'grainRoughness',
      mapping: 'linear',
      decimals: 0,
    },
  ],
  splitTone: [
    {
      id: 'balance',
      label: 'Balance',
      field: 'splitToneBalance',
      mapping: 'anchored',
      decimals: 0,
    },
    {
      id: 'shadowHue',
      label: 'Sh Hue',
      field: 'splitToneShadowHue',
      mapping: 'linear',
      decimals: 0,
    },
    {
      id: 'shadowSat',
      label: 'Sh Sat',
      field: 'splitToneShadowSaturation',
      mapping: 'linear',
      decimals: 0,
    },
    {
      id: 'highlightHue',
      label: 'Hi Hue',
      field: 'splitToneHighlightHue',
      mapping: 'linear',
      decimals: 0,
    },
    {
      id: 'highlightSat',
      label: 'Hi Sat',
      field: 'splitToneHighlightSaturation',
      mapping: 'linear',
      decimals: 0,
    },
  ],
  noise: [
    { id: 'luminance', label: 'Luminance', field: 'nrLuminance', mapping: 'linear', decimals: 0 },
    { id: 'color', label: 'Color', field: 'nrColor', mapping: 'linear', decimals: 0 },
    // Tiers 3 and 1 of the § 3 noise architecture (#1153). Both live inside
    // the DECODE PRODUCT, so both commit on release: Deep (BM3D, #1105) costs
    // seconds per re-develop, Prefilter (#1104) rides the same decode. Order
    // follows spec § 10.0: "Luminance, Color (existing NLM), Deep, Prefilter".
    {
      id: 'deep',
      label: 'Deep',
      field: 'deepDenoise',
      mapping: 'linear',
      decimals: 0,
      commitOnRelease: true,
    },
    {
      id: 'prefilter',
      label: 'Prefilter',
      field: 'chromaPrefilter',
      mapping: 'linear',
      decimals: 0,
      commitOnRelease: true,
    },
  ],
  sharpen: [
    { id: 'amount', label: 'Amount', field: 'sharpenAmount', mapping: 'anchored', decimals: 0 },
    { id: 'radius', label: 'Radius', field: 'sharpenRadius', mapping: 'anchored', decimals: 1 },
    { id: 'detail', label: 'Detail', field: 'sharpenDetail', mapping: 'linear', decimals: 0 },
    { id: 'masking', label: 'Masking', field: 'sharpenMasking', mapping: 'linear', decimals: 0 },
  ],
};

const GENERATED_DEFAULTS = defaultGeneratedAdjustmentModel();

/** Ordered sub-params for a tool; empty for single-param tools. */
export function subParamsFor(tool: ToolId): readonly ToolSubParam[] {
  return SUB_PARAMS[tool] ?? [];
}

/** True when the tool shows the sub-param chip row (≥ 2 sub-params). */
export function isMultiParam(tool: ToolId): boolean {
  return subParamsFor(tool).length > 1;
}

export function subParamById(tool: ToolId, id: string): ToolSubParam | null {
  return subParamsFor(tool).find((s) => s.id === id) ?? null;
}

/** Default armed sub-param id (first in the list); null for single-param. */
export function defaultSubParamId(tool: ToolId): string | null {
  return subParamsFor(tool)[0]?.id ?? null;
}

/** True when the sub-param's model write is deferred to gesture end. */
export function isCommitOnRelease(sub: ToolSubParam | null): boolean {
  return sub?.commitOnRelease === true;
}

export function subParamDisplayRange(sub: ToolSubParam): readonly [number, number] {
  return ADJUSTMENT_RANGES[sub.field];
}

/** Canonical default display value — the generated field default. */
export function subParamDefaultDisplay(sub: ToolSubParam): number {
  return GENERATED_DEFAULTS[sub.field];
}

/** Internal `[-100, +100]` → display. Same math as the tool-level
 * mapping families in tool-model.ts, generalized per descriptor. */
export function subParamDisplayFromInternal(sub: ToolSubParam, v: number): number {
  const [lo, hi] = subParamDisplayRange(sub);
  if (sub.mapping === 'linear') {
    return lo + ((v + 100) / 200) * (hi - lo);
  }
  const a = subParamDefaultDisplay(sub);
  return v >= 0 ? a + (v / 100) * (hi - a) : a + (v / 100) * (a - lo);
}

/** Inverse of `subParamDisplayFromInternal`. */
export function subParamInternalFromDisplay(sub: ToolSubParam, d: number): number {
  const [lo, hi] = subParamDisplayRange(sub);
  if (sub.mapping === 'linear') {
    return ((d - lo) / (hi - lo)) * 200 - 100;
  }
  const a = subParamDefaultDisplay(sub);
  return d >= a ? ((d - a) / (hi - a)) * 100 : ((d - a) / (a - lo)) * 100;
}

/**
 * Value-chip text for a sub-param ("DETAIL · SHARPEN · RADIUS · 1.0").
 * Signed only when the range spans negative (spec §10.0 shows one-sided
 * sub-params unsigned: "FEATHER · 35"); `decimals` fraction digits.
 */
export function formatSubParamValue(sub: ToolSubParam, d: number): string {
  const [lo] = subParamDisplayRange(sub);
  const scale = 10 ** sub.decimals;
  const rounded = Math.round(d * scale) / scale;
  const magnitude = Math.abs(rounded).toFixed(sub.decimals);
  if (rounded < 0) return `-${magnitude}`;
  return lo < 0 ? `+${magnitude}` : magnitude;
}
