// tool-metadata.ts — generated-derived per-tool metadata (#2448).
//
// One place that turns the generated schema tables into what a slider
// control needs: range, default, step, readout decimals, reset target and
// copy/paste group. Every value here is DERIVED from `ADJUSTMENT_RANGES`,
// `defaultGeneratedAdjustmentModel()` and `ADJUSTMENT_GROUPS` (all emitted
// by `tools/codegen.sh` from raw-core), so a control card, the scrub HUD
// and the parity checker cannot disagree with each other or with Apple —
// the step and decimals used to be hand-coded per tool in
// `control-card.component.ts` / `editor-shell-hud.ts`.

import {
  ADJUSTMENT_GROUPS,
  ADJUSTMENT_RANGES,
  type AdjustmentGroupId,
} from '../generated/adjustment-tables.generated';
import { defaultGeneratedAdjustmentModel } from '../generated/adjustment-model.generated';
import { camelToSnakeField } from './presets/preset-model';
import { fieldFor, type ToolId } from './tool-model';

/** Scalar schema fields — exactly the keys carrying a generated range. */
export type SchemaField = keyof typeof ADJUSTMENT_RANGES;

export interface ToolMetadata {
  readonly field: SchemaField;
  readonly range: readonly [number, number];
  /** Canonical default; also the reset target (`defaultDisplayValue`). */
  readonly defaultValue: number;
  /** Keyboard / drag quantum in display units. */
  readonly step: number;
  /** Readout fraction digits, derived from `step`. */
  readonly decimals: number;
  /** Copy / paste / sync group the field belongs to (#944). */
  readonly copyGroup: AdjustmentGroupId | null;
}

const GENERATED_DEFAULTS = defaultGeneratedAdjustmentModel();

/**
 * Step from the range width: a stop-scaled range (exposure, ±4 EV) wants
 * hundredths, a Kelvin range (10 000 K wide) wants 50 K detents, everything
 * else (±100 / 0–100 / ±150) moves by one.
 */
function stepForRange([lo, hi]: readonly [number, number]): number {
  const width = hi - lo;
  if (width <= 10) return 0.01;
  if (width >= 5000) return 50;
  return 1;
}

function decimalsForStep(step: number): number {
  if (step < 0.1) return 2;
  if (step < 1) return 1;
  return 0;
}

/** The generated copy/paste group a camelCase field belongs to. */
function copyGroupForField(field: string): AdjustmentGroupId | null {
  const snake = camelToSnakeField(field);
  return ADJUSTMENT_GROUPS.find((group) => group.fields.includes(snake))?.id ?? null;
}

export function isSchemaField(field: string): field is SchemaField {
  return Object.prototype.hasOwnProperty.call(ADJUSTMENT_RANGES, field);
}

export function fieldMetadata(field: SchemaField): ToolMetadata {
  const range = ADJUSTMENT_RANGES[field];
  const raw = GENERATED_DEFAULTS[field as keyof typeof GENERATED_DEFAULTS];
  const step = stepForRange(range);
  return {
    field,
    range,
    defaultValue: typeof raw === 'number' ? raw : 0,
    step,
    decimals: decimalsForStep(step),
    copyGroup: copyGroupForField(field),
  };
}

/** Metadata for a tool's PRIMARY field; `null` for field-less tools
 *  (HSL, B&W, film, lens, crop, presets). */
export function toolMetadata(tool: ToolId): ToolMetadata | null {
  const field = fieldFor(tool);
  return field !== null && isSchemaField(field) ? fieldMetadata(field) : null;
}
