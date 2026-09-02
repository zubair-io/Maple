// xmp-adjustment-walk.ts — the attribute-walk orchestration split out of
// `XmpParserService.parseAdjustmentModel` (#1840, complexity hotspot):
// pass 1 (canonical fields + per-group dispatch + legacy deferral) and pass
// 2 (legacy-alias application). The per-group parsers themselves live in
// `xmp-look-profile.ts`, `xmp-enum-attrs.ts`, and `xmp-crop.ts`.

import type { AdjustmentModel, WhiteBalancePreset } from '../models/adjustment-model';
import { ADJUSTMENT_FIELDS, LEGACY_READ_ALIASES, WB_PRESET_FIELD } from './xmp-fields';
import {
  applyLookAttribute,
  applyProfileAttribute,
  newLookProfileState,
  type LookProfileState,
} from './xmp-look-profile';
import { applyEnumAttribute } from './xmp-enum-attrs';
import { applyCropAttribute, newCropAccumulator, type CropAccumulator } from './xmp-crop';
import { managedXmpName } from './xmp-dom-utils';

/**
 * Precomputed `xmpKey → alias` lookup for `LEGACY_READ_ALIASES`. Used by both
 * passes to replace per-attribute `Array.some` / `Array.find` scans with
 * O(1) `Map.get`. Sidecars routinely carry 30+ attributes so the constant
 * factor matters even at the current 1-entry alias table.
 */
const LEGACY_READ_ALIASES_MAP = new Map(LEGACY_READ_ALIASES.map((a) => [a.xmpKey, a]));

export interface AdjustmentAttributeWalkResult {
  model: Partial<AdjustmentModel>;
  /** Model keys already populated from a canonical `ADJUSTMENT_FIELDS` entry,
   * so `applyLegacyAliases` never overwrites them. Matches raw-core's
   * `sigma_seen` precedence (#463): when both `papp:CaptureSharpeningSigma`
   * and the legacy `papp:CaptureSharpeningRadius` are present, sigma wins. */
  canonicallyApplied: Set<keyof AdjustmentModel>;
  /** Legacy-aliased attributes seen during the walk, deferred for `applyLegacyAliases`. */
  legacyDeferred: Array<{ name: string; value: string }>;
  cropAcc: CropAccumulator;
}

/**
 * Every attribute group besides the canonical numeric fields and the legacy
 * aliases (both handled inline in `walkAdjustmentAttributes` since they need
 * `ADJUSTMENT_FIELDS`/`LEGACY_READ_ALIASES_MAP` lookups): WB preset,
 * Look/Profile, the single-attribute enums, and crop/straighten. Bundled
 * into one dispatcher purely to keep `walkAdjustmentAttributes`'s own branch
 * count low — every attribute name across these groups is mutually
 * exclusive, so the order between them doesn't affect the result. Returns
 * whether `name` was recognized by any of them.
 */
function applyMiscAdjustmentAttribute(
  model: Partial<AdjustmentModel>,
  name: string,
  rawValue: string,
  ctx: { lookProfileState: LookProfileState; cropAcc: CropAccumulator; hasCrop: boolean },
): boolean {
  if (name === WB_PRESET_FIELD.xmpKey) {
    model.whiteBalancePreset = rawValue as WhiteBalancePreset;
    return true;
  }
  if (name === 'papp:Look') {
    applyLookAttribute(model, rawValue, ctx.lookProfileState);
    return true;
  }
  if (name === 'papp:Profile') {
    applyProfileAttribute(model, rawValue, ctx.lookProfileState);
    return true;
  }
  if (applyEnumAttribute(model, name, rawValue)) return true;
  // Crop / straighten (#277). HasCrop and CropConstrainToWarp are in
  // KNOWN_ATTRIBUTES so they don't fall into the passthrough bucket.
  return applyCropAttribute(ctx.cropAcc, name, rawValue, ctx.hasCrop);
}

/**
 * Pass 1: walks `desc`'s attributes, applying canonical numeric fields and
 * every per-group parser, and remembering legacy-aliased attributes for
 * `applyLegacyAliases` (pass 2).
 */
export function walkAdjustmentAttributes(
  desc: Element,
  hasCrop: boolean,
): AdjustmentAttributeWalkResult {
  const model: Partial<AdjustmentModel> = {};
  const canonicallyApplied = new Set<keyof AdjustmentModel>();
  const legacyDeferred: Array<{ name: string; value: string }> = [];
  const miscCtx = {
    lookProfileState: newLookProfileState(),
    cropAcc: newCropAccumulator(),
    hasCrop,
  };

  for (let i = 0; i < desc.attributes.length; i++) {
    const attr = desc.attributes[i];
    const name = managedXmpName(attr);
    if (!name) continue;

    const mapping = ADJUSTMENT_FIELDS.find((f) => f.xmpKey === name);
    if (mapping) {
      const parsed = mapping.parse(attr.value);
      if (!Number.isNaN(parsed)) {
        // Narrowed: every ADJUSTMENT_FIELDS entry is keyed on a numeric
        // AdjustmentModel field, so `parsed` is assignable to model[modelKey].
        model[mapping.modelKey] = parsed;
        canonicallyApplied.add(mapping.modelKey);
      }
      continue;
    }

    if (LEGACY_READ_ALIASES_MAP.has(name)) {
      legacyDeferred.push({ name, value: attr.value });
      continue;
    }

    applyMiscAdjustmentAttribute(model, name, attr.value, miscCtx);
  }

  return { model, canonicallyApplied, legacyDeferred, cropAcc: miscCtx.cropAcc };
}

/**
 * Pass 2: applies legacy aliases only where the canonical key didn't already
 * populate the field. DOMParser preserves source order, but this two-pass
 * design makes the sigma-wins contract source-order independent.
 */
export function applyLegacyAliases(
  model: Partial<AdjustmentModel>,
  legacyDeferred: ReadonlyArray<{ name: string; value: string }>,
  canonicallyApplied: ReadonlySet<keyof AdjustmentModel>,
): void {
  for (const { name, value } of legacyDeferred) {
    const alias = LEGACY_READ_ALIASES_MAP.get(name);
    if (!alias) continue;
    if (canonicallyApplied.has(alias.modelKey)) continue;
    const parsed = alias.parse(value);
    if (!Number.isNaN(parsed)) {
      model[alias.modelKey] = parsed;
    }
  }
}
