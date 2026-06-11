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
}

// Sub-param catalogs for the multi-param pills. §10.0: the Noise pill's
// future tiers — Deep (BM3D, #1105) and Prefilter (§3.1) — join the
// `noise` list data-only when their pipeline stages land. Grain / split
// tone gain their satellite sub-params the same way when #1110 / #1111
// un-stub them; vignette joined at #1109.
const SUB_PARAMS: Partial<Record<ToolId, readonly ToolSubParam[]>> = {
  vignette: [
    { id: 'amount', label: 'Amount', field: 'vignetteAmount', mapping: 'anchored', decimals: 0 },
    { id: 'feather', label: 'Feather', field: 'vignetteFeather', mapping: 'linear', decimals: 0 },
  ],
  noise: [
    { id: 'luminance', label: 'Luminance', field: 'nrLuminance', mapping: 'linear', decimals: 0 },
    { id: 'color', label: 'Color', field: 'nrColor', mapping: 'linear', decimals: 0 },
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
