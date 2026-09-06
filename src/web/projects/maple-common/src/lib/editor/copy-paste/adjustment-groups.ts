// adjustment-groups.ts — copy / paste / sync group-patch builder (#944).
//
// `ADJUSTMENT_GROUPS` (generated from raw-core's single-source-of-truth
// group→field table, `adjustment-tables.generated.ts`) lists each group's
// canonical snake_case field names. `buildGroupPatch` turns a SOURCE
// `AdjustmentModel` plus a set of selected group ids into the
// `Partial<AdjustmentModel>` patch that copy / paste / sync writes onto a
// target asset via `LibraryStateService.updateAdjustment`.
//
// Unlike `capturePresetFields` (which only captures fields that differ
// from default, for sparse preset storage), this builder is DENSE: every
// selected field is copied at its source value even when that value equals
// the schema default — a paste must be able to overwrite a target's
// non-default `exposure` with the source's `exposure: 0`, not skip it.
//
// Reuses `preset-model.ts`'s snake/camel conversion and its
// `buildApplyPatch` clamp + enum-validation pass rather than duplicating
// that logic — the group patch is validated exactly like a preset apply.
//
// Two `AdjustmentGroupSpec.fields` entries have no `GeneratedAdjustmentModel`
// counterpart and need explicit handling instead of falling out of the
// generic dense-field loop:
//
//   - `white_balance` carries `wb_method` (a real schema field, handled
//     generically) plus `temperature_seen` / `tint_seen` (raw-core parse
//     state with no TS mirror at all — skipped, same as any other unknown
//     field) — but the group's *intent* also covers the web-only
//     `whiteBalancePreset` selector and `wbScaleVersion` scale marker
//     (`adjustment-model.ts`). Both are carried explicitly: without
//     `whiteBalancePreset`, `LibraryStore.setAdjustment` sees a
//     temperature/tint change with no explicit preset and auto-flips the
//     target to `'Custom'`, silently changing WB semantics instead of
//     mirroring the source's actual preset state (e.g. `'As Shot'`).
//   - `geometry` lists `crop`, which is a nested `Crop` struct
//     (`adjustment-model.ts`), not a `GeneratedAdjustmentModel` scalar —
//     copied as a fresh object so the patch never aliases the source's
//     live `Crop`.
import {
  defaultGeneratedAdjustmentModel,
  type GeneratedAdjustmentModel,
} from '../../generated/adjustment-model.generated';
// Copy/paste group tables live in the sibling generated file (#2683 — split
// out to keep both generated files well under the file-size budget as the
// schema grows).
import {
  ADJUSTMENT_GROUPS,
  type AdjustmentGroupId,
  type AdjustmentGroupSpec,
} from '../../generated/adjustment-tables.generated';
import type { AdjustmentModel } from '../../models/adjustment-model';
import { ADJUSTMENT_TRANSFER_MODES } from '../../generated/adjustment-transfer.generated';
import { buildApplyPatch, camelToSnakeField, type PresetFields } from '../presets/preset-model';

export type {
  AdjustmentGroupId,
  AdjustmentGroupSpec,
} from '../../generated/adjustment-tables.generated';
export { ADJUSTMENT_GROUPS } from '../../generated/adjustment-tables.generated';

/** Every group id, in the order the selective-paste UI presents them. */
export const ALL_ADJUSTMENT_GROUP_IDS: readonly AdjustmentGroupId[] = ADJUSTMENT_GROUPS.map(
  (g) => g.id,
);

const GENERATED_KEYS = Object.keys(
  defaultGeneratedAdjustmentModel(),
) as (keyof GeneratedAdjustmentModel)[];

/**
 * Build the `Partial<AdjustmentModel>` patch that copying `source`'s
 * `groups` onto another asset should write. Fields the TS model doesn't
 * mirror (`temperature_seen`, `tint_seen`, …) are skipped silently, exactly
 * like `buildApplyPatch` skips unknown preset keys.
 *
 * Point curves are cloned independently of the scalar preset validator. Crop
 * copies normalized coordinates (AssetRelative); no asset-local provenance is copied.
 */
export function buildGroupPatch(
  source: AdjustmentModel,
  groups: readonly AdjustmentGroupId[],
): Partial<AdjustmentModel> {
  const selected = new Set(groups);
  const selectedFieldNames = new Set(
    ADJUSTMENT_GROUPS.filter((g) => selected.has(g.id)).flatMap((g) => g.fields),
  );

  // Dense snake_case → value map for every canonical schema field that
  // belongs to a selected group, read from the FULL source model (not just
  // its non-default fields).
  const denseFields: PresetFields = {};
  for (const camelKey of GENERATED_KEYS) {
    const snakeKey = camelToSnakeField(camelKey);
    if (!selectedFieldNames.has(snakeKey)) continue;
    const mode = ADJUSTMENT_TRANSFER_MODES[snakeKey];
    if (mode === 'Unsupported') continue;
    if (mode !== 'Absolute') throw new Error(`No scalar transfer implementation for ${snakeKey}`);
    const value = source[camelKey];
    if (typeof value === 'object') continue; // Copied structurally below.
    denseFields[snakeKey] = value;
  }

  const patch: Partial<AdjustmentModel> = buildApplyPatch(denseFields);
  for (const key of GENERATED_KEYS) {
    const field = camelToSnakeField(key);
    if (!selectedFieldNames.has(field) || ADJUSTMENT_TRANSFER_MODES[field] !== 'Absolute') continue;
    const value = source[key];
    if (typeof value === 'object' && value !== null) {
      Object.assign(patch, { [key]: structuredClone(value) });
    }
  }

  // Web-only extensions carried alongside a schema-generated group but not
  // part of `GeneratedAdjustmentModel` itself — see module doc.
  if (selected.has('white_balance')) {
    patch.whiteBalancePreset = source.whiteBalancePreset;
    patch.wbScaleVersion = source.wbScaleVersion;
    patch.wbSampleX = 0;
    patch.wbSampleY = 0;
    patch.wbAlgorithmVersion = 0;
  }
  if (selected.has('geometry') && ADJUSTMENT_TRANSFER_MODES['crop'] === 'AssetRelative') {
    patch.crop = { ...source.crop };
  }

  return patch;
}
