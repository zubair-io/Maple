// adjustment-groups.spec.ts — group-patch builder tests (#944).

import { describe, expect, it } from 'vitest';

import {
  ADJUSTMENT_NON_COPYABLE_FIELDS,
  defaultGeneratedAdjustmentModel,
} from '../../generated/adjustment-model.generated';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import { camelToSnakeField } from '../presets/preset-model';
import { ADJUSTMENT_GROUPS, ALL_ADJUSTMENT_GROUP_IDS, buildGroupPatch } from './adjustment-groups';

describe('ALL_ADJUSTMENT_GROUP_IDS', () => {
  it('lists every ADJUSTMENT_GROUPS id, in order', () => {
    expect(ALL_ADJUSTMENT_GROUP_IDS).toEqual(ADJUSTMENT_GROUPS.map((g) => g.id));
  });
});

// Web-side mirror of raw-core's `every_field_is_grouped_or_explicitly_excluded`
// guard (`schema/groups/tests.rs`). Both tables are emitted from the same
// raw-core source by `tools/codegen.sh`, so this asserts that the emitted TS
// copy really does partition the schema: a field that lands in neither the
// group table nor the non-copyable list would be silently dropped by every
// copy / paste / sync on the web client.
describe('group table coverage', () => {
  const groupedFields = ADJUSTMENT_GROUPS.flatMap((g) => g.fields);

  it('assigns every generated schema field to a group or the non-copyable list', () => {
    const covered = new Set([...groupedFields, ...ADJUSTMENT_NON_COPYABLE_FIELDS]);
    const uncovered = Object.keys(defaultGeneratedAdjustmentModel())
      .map(camelToSnakeField)
      .filter((name) => !covered.has(name));
    expect(uncovered).toEqual([]);
  });

  it('never lists the same field in two groups', () => {
    const repeated = groupedFields.filter((name, i) => groupedFields.indexOf(name) !== i);
    expect(repeated).toEqual([]);
  });

  it('never lists a non-copyable field in a group', () => {
    const grouped = new Set(groupedFields);
    expect(ADJUSTMENT_NON_COPYABLE_FIELDS.filter((name) => grouped.has(name))).toEqual([]);
  });
});

describe('buildGroupPatch', () => {
  it('returns an empty patch when no groups are selected', () => {
    const source = defaultAdjustmentModel();
    source.exposure = 1.5;
    expect(buildGroupPatch(source, [])).toEqual({});
  });

  it('copies a scalar field even when it still equals the schema default', () => {
    // Dense copy, unlike capturePresetFields' sparse "non-default only"
    // capture — a paste must be able to zero-out a target's non-default
    // exposure by writing the source's default 0.
    const source = defaultAdjustmentModel();
    expect(source.exposure).toBe(0);
    const patch = buildGroupPatch(source, ['tone']);
    expect(patch.exposure).toBe(0);
  });

  it('carries every scalar field belonging to the selected group, with source values', () => {
    const source = defaultAdjustmentModel();
    source.exposure = 1.25;
    source.contrast = -30;
    source.highlights = 40;
    source.autoExposure = 'Off';
    // Field from a different group must not leak in.
    source.saturation = 99;

    const patch = buildGroupPatch(source, ['tone']);
    expect(patch.exposure).toBe(1.25);
    expect(patch.contrast).toBe(-30);
    expect(patch.highlights).toBe(40);
    expect(patch.autoExposure).toBe('Off');
    expect(patch.saturation).toBeUndefined();
  });

  it('skips the structured tone-curve fields, keeping its scalar siblings', () => {
    // `PresetFields` — what `buildApplyPatch` clamps and validates — is a flat
    // scalar map, and the web XMP layer does not serialise point curves yet
    // (#367), so carrying them would paste state that vanishes on reload.
    // Same guard, same reason, as `capturePresetFields`.
    const source = defaultAdjustmentModel();
    source.toneCurveLuma = {
      points: [
        [0, 0],
        [1, 0.5],
      ],
    };
    source.exposure = 1.5;

    const patch = buildGroupPatch(source, ['tone']);
    expect(patch.toneCurveLuma).toBeUndefined();
    expect(patch.exposure).toBe(1.5);
  });

  it('unions fields across multiple selected groups', () => {
    const source = defaultAdjustmentModel();
    source.exposure = 2;
    source.vibrance = 20;
    source.clarity = 15;

    const patch = buildGroupPatch(source, ['tone', 'color']);
    expect(patch.exposure).toBe(2);
    expect(patch.vibrance).toBe(20);
    expect(patch.clarity).toBeUndefined(); // detail group not selected
  });

  it('white_balance group carries whiteBalancePreset and wbScaleVersion alongside temperature/tint', () => {
    const source = defaultAdjustmentModel();
    source.temperature = 5200;
    source.tint = -12;
    source.whiteBalancePreset = 'Daylight';
    source.wbScaleVersion = 5;

    const patch = buildGroupPatch(source, ['white_balance']);
    expect(patch.temperature).toBe(5200);
    expect(patch.tint).toBe(-12);
    expect(patch.whiteBalancePreset).toBe('Daylight');
    expect(patch.wbScaleVersion).toBe(5);
  });

  it('omits whiteBalancePreset/wbScaleVersion when white_balance is not selected', () => {
    const source = defaultAdjustmentModel();
    source.whiteBalancePreset = 'Daylight';
    const patch = buildGroupPatch(source, ['tone']);
    expect(patch.whiteBalancePreset).toBeUndefined();
    expect(patch.wbScaleVersion).toBeUndefined();
  });

  it('geometry group copies crop as a fresh, non-aliased object', () => {
    const source = defaultAdjustmentModel();
    source.crop = { top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 3 };

    const patch = buildGroupPatch(source, ['geometry']);
    expect(patch.crop).toEqual(source.crop);
    expect(patch.crop).not.toBe(source.crop);

    // Mutating the source afterwards must not affect the patch.
    source.crop.angle = 45;
    expect(patch.crop?.angle).toBe(3);
  });

  it('omits crop when geometry is not selected', () => {
    const source = defaultAdjustmentModel();
    const patch = buildGroupPatch(source, ['tone', 'color', 'detail', 'effects', 'white_balance']);
    expect(patch.crop).toBeUndefined();
  });

  it('selecting every group round-trips every schema-mirrored scalar/enum field', () => {
    const source = defaultAdjustmentModel();
    source.exposure = 1;
    source.vibrance = 2;
    source.clarity = 3;
    source.vignetteAmount = 4;
    source.highlightRecovery = 'Blend';

    const patch = buildGroupPatch(source, ALL_ADJUSTMENT_GROUP_IDS);
    expect(patch.exposure).toBe(1);
    expect(patch.vibrance).toBe(2);
    expect(patch.clarity).toBe(3);
    expect(patch.vignetteAmount).toBe(4);
    expect(patch.highlightRecovery).toBe('Blend');
    expect(patch.crop).toEqual(source.crop);
    expect(patch.whiteBalancePreset).toBe(source.whiteBalancePreset);
  });
});
