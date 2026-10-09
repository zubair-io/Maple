// The Color range refinement on a local correction (`papp:Range*`), split
// from `xmp-local-adjustments.ts` (at its file budget). Mirrors raw-core's
// `RangeRefinement::Color` codec.
import type { RangeRefinement } from '../models/local-adjustment';
import { attrOf } from './xmp-dom-utils';
import { finiteAttr } from './xmp-crs-corrections';
import { numericSerializer } from './xmp-fields';

/** Canonical order and raw-core's defaults for missing Color range attributes. */
export const RANGE_KEYS: ReadonlyArray<
  readonly [string, Exclude<keyof RangeRefinement, 'kind'>, number]
> = [
  ['papp:RangeHue', 'hueDeg', 55],
  ['papp:RangeHueWidth', 'hueHalfWidthDeg', 25],
  ['papp:RangeChromaMin', 'chromaMin', 0.02],
  ['papp:RangeLMin', 'lMin', 0.15],
  ['papp:RangeLMax', 'lMax', 0.95],
  ['papp:RangeFeather', 'feather', 0.3],
];

export function parseRange(description: Element): RangeRefinement | undefined {
  if (attrOf(description, ['papp:RangeKind']) !== 'Color') return undefined;
  const values = RANGE_KEYS.map(([key, field, fallback]) => {
    const value = attrOf(description, [key]) === null ? fallback : finiteAttr(description, key);
    return [field, value] as const;
  });
  // A corrupt range is absent; a missing numeric attribute uses raw-core's default.
  if (values.some(([, value]) => value === undefined)) return undefined;
  return { kind: 'color', ...Object.fromEntries(values) } as RangeRefinement;
}

export function rangeLines(range: RangeRefinement | undefined, indent: string): string[] {
  if (!range || RANGE_KEYS.some(([, field]) => !Number.isFinite(range[field]))) return [];
  return [
    `${indent}papp:RangeKind="Color"`,
    ...RANGE_KEYS.map(([key, field]) => `${indent}${key}="${numericSerializer(range[field])}"`),
  ];
}
