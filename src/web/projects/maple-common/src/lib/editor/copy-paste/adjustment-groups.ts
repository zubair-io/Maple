// adjustment-groups.ts — copy / paste / sync group-patch builder (#944).
//
// `ADJUSTMENT_GROUPS` (generated from raw-core's single-source-of-truth
// group→field table, `adjustment-model.generated.ts`) lists each group's
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
  ADJUSTMENT_GROUPS,
  defaultGeneratedAdjustmentModel,
  type AdjustmentGroupId,
  type AdjustmentGroupSpec,
  type GeneratedAdjustmentModel,
} from '../../generated/adjustment-model.generated';
import type { AdjustmentModel } from '../../models/adjustment-model';
import { buildApplyPatch, camelToSnakeField, type PresetFields } from '../presets/preset-model';

export type {
  AdjustmentGroupId,
  AdjustmentGroupSpec,
} from '../../generated/adjustment-model.generated';
export { ADJUSTMENT_GROUPS } from '../../generated/adjustment-model.generated';

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
 * Structured fields are skipped too: the four `tone_curve_*` point curves
 * (#366) are `ToneCurve` objects, and `PresetFields` — the map
 * `buildApplyPatch` clamps and validates — is a flat scalar map on both the
 * client and the API validator. Same guard, same reason, as
 * `capturePresetFields`. Point-curve copy waits on the curve editor (#367);
 * `crop`, the other structured field, is carried explicitly below because
 * `geometry` is a real group today.
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
    const value = source[camelKey];
    if (typeof value === 'object') continue; // ToneCurve — see doc above.
    denseFields[snakeKey] = value;
  }

  const patch: Partial<AdjustmentModel> = buildApplyPatch(denseFields);

  // Web-only extensions carried alongside a schema-generated group but not
  // part of `GeneratedAdjustmentModel` itself — see module doc.
  if (selected.has('white_balance')) {
    patch.whiteBalancePreset = source.whiteBalancePreset;
    patch.wbScaleVersion = source.wbScaleVersion;
  }
  if (selected.has('geometry')) {
    patch.crop = { ...source.crop };
  }

  return patch;
}
