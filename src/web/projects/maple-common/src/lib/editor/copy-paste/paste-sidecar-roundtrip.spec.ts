// paste-sidecar-roundtrip.spec.ts — the sidecar contract for copy / paste /
// sync (#944).
//
// The acceptance criterion the ticket actually turns on is "each target's XMP
// updates" — and, just as importantly, that nothing ELSE in that target's
// sidecar moves. `buildGroupPatch` returning the right object is necessary but
// not sufficient: what lands on disk is the patched model run back through
// `XmpSerializerService`, so the contract has to be asserted at the XMP text,
// not at the patch.
//
// These tests use the REAL serializer and parser (repo rule: no mocks for the
// sidecar layer). The browser has no filesystem, so the round trip is
// serialize → parse rather than write-file → read-file; the bytes exercised
// are identical to the ones `SidecarStore.write` / `XmpStoreService` put on
// disk, because both call this same serializer.

import { describe, expect, it } from 'vitest';

import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import { XmpParserService } from '../../xmp/xmp-parser.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { ALL_ADJUSTMENT_GROUP_IDS, buildGroupPatch } from './adjustment-groups';

const ser = new XmpSerializerService();
const parser = new XmpParserService();

// Both models author WB explicitly. The serializer omits `crs:Temperature` /
// `crs:Tint` entirely while `whiteBalancePreset` is `'As Shot'` (the as-shot
// gate), so a model left on the default preset can't demonstrate anything
// about whether paste moved or preserved the WB numbers.

/** The image the user copied FROM — something non-default in every group. */
function sourceModel(): AdjustmentModel {
  return {
    ...defaultAdjustmentModel(),
    whiteBalancePreset: 'Custom',
    temperature: 7800,
    tint: 12,
    exposure: 1.75,
    contrast: 40,
    highlights: -60,
    shadows: 35,
    vibrance: 22,
    saturation: -15,
    clarity: 18,
    sharpenAmount: 70,
    vignetteAmount: -25,
    crop: { top: 0.1, left: 0.05, bottom: 0.9, right: 0.95, angle: 2.5 },
  };
}

/** An image the user pasted ONTO — different values, so a leak is visible. */
function targetModel(): AdjustmentModel {
  return {
    ...defaultAdjustmentModel(),
    whiteBalancePreset: 'Custom',
    temperature: 5100,
    tint: -8,
    exposure: -0.5,
    saturation: 44,
    clarity: -10,
    sharpenAmount: 55,
    vignetteAmount: 10,
  };
}

/** The culling the target already carries; a paste must not disturb it. */
const targetCulling = {
  rating: 4,
  flag: 'pick',
  colorLabel: 'green',
  keywords: ['portrait', 'client-work'],
} as const;

/** Apply a group patch the way `LibraryStore.setAdjustment` does, then write
 *  and read the sidecar the way `scheduleSidecarWrite` does. */
function pasteAndRoundTrip(groups: readonly (typeof ALL_ADJUSTMENT_GROUP_IDS)[number][]): {
  model: Partial<AdjustmentModel>;
  xml: string;
} {
  const patched: AdjustmentModel = { ...targetModel(), ...buildGroupPatch(sourceModel(), groups) };
  const xml = ser.serialize(patched, undefined, targetCulling);
  return { model: parser.parseAdjustmentModel(xml).model, xml };
}

describe('paste → sidecar round trip (#944)', () => {
  it('moves the selected group and leaves every other group at the target value', () => {
    const { model } = pasteAndRoundTrip(['tone']);

    // Tone came from the source.
    expect(model.exposure).toBe(1.75);
    expect(model.contrast).toBe(40);
    expect(model.highlights).toBe(-60);
    expect(model.shadows).toBe(35);

    // Everything else is still the TARGET's own edit.
    expect(model.temperature).toBe(5100);
    expect(model.tint).toBe(-8);
    expect(model.saturation).toBe(44);
    expect(model.clarity).toBe(-10);
    expect(model.sharpenAmount).toBe(55);
    expect(model.vignetteAmount).toBe(10);
  });

  it('preserves the target rating, flag, colour label and keywords', () => {
    const { xml } = pasteAndRoundTrip(['tone', 'color']);
    const culling = parser.parseCulling(xml);

    expect(culling.rating).toBe(4);
    expect(culling.flag).toBe('pick');
    expect(culling.colorLabel).toBe('green');
    expect(culling.keywords).toEqual(['portrait', 'client-work']);
  });

  it('preserves unknown passthrough attributes written by another tool', () => {
    // A sidecar authored elsewhere carries an attribute Maple does not model.
    // Paste rewrites the whole file, so that attribute has to come back out.
    // `xmp:CreatorTool` is deliberately chosen from a namespace the serializer
    // already declares — the passthrough writer re-emits the attribute but not
    // its `xmlns:` declaration, so a foreign PREFIX would re-serialise into a
    // document with an undeclared prefix. That is a pre-existing serializer
    // limitation, not a paste behaviour, so it is not asserted here.
    const foreign = ser
      .serialize(targetModel(), undefined, targetCulling)
      .replace('xmp:Rating=', 'xmp:CreatorTool="Some Other App"\n   xmp:Rating=');
    const { passthrough } = parser.parseAdjustmentModel(foreign);
    expect(passthrough.unknownAttributes.some((a) => a.name === 'xmp:CreatorTool')).toBe(true);

    const patched: AdjustmentModel = {
      ...targetModel(),
      ...buildGroupPatch(sourceModel(), ['tone']),
    };
    const rewritten = ser.serialize(patched, passthrough, targetCulling);

    expect(rewritten).toContain('xmp:CreatorTool="Some Other App"');
    expect(parser.parseAdjustmentModel(rewritten).model.exposure).toBe(1.75);
  });

  it('carries crop only when the geometry group is pasted', () => {
    const withoutGeometry = pasteAndRoundTrip(['tone', 'color', 'detail', 'effects']);
    // Target crop is identity, and the serializer omits the whole crs:Crop*
    // group for an identity crop — so the source's crop must not appear.
    expect(withoutGeometry.xml).not.toContain('crs:HasCrop');

    const withGeometry = pasteAndRoundTrip(['geometry']);
    expect(withGeometry.xml).toContain('crs:HasCrop="True"');
    expect(withGeometry.model.crop?.angle).toBeCloseTo(2.5, 3);
  });

  it('pasting every group makes the target byte-identical to the source sidecar', () => {
    // "Sync settings" is paste-everything: the two sidecars must agree on
    // every adjustment. Culling is deliberately excluded from the comparison —
    // stars and flags are per-image and never synced.
    const patched: AdjustmentModel = {
      ...targetModel(),
      ...buildGroupPatch(sourceModel(), ALL_ADJUSTMENT_GROUP_IDS),
    };
    expect(ser.serialize(patched)).toBe(ser.serialize(sourceModel()));
  });

  it('resets a target field the source left at its default', () => {
    // The regression `capturePresetFields`' sparse capture would cause: the
    // source has no vignette, the target does, and pasting Effects has to
    // clear it rather than skip it.
    const { model } = pasteAndRoundTrip(['effects']);
    expect(sourceModel().vignetteAmount).toBe(-25);
    expect(model.vignetteAmount).toBe(-25);

    const noEffectsSource = { ...sourceModel(), vignetteAmount: 0 };
    const patched: AdjustmentModel = {
      ...targetModel(),
      ...buildGroupPatch(noEffectsSource, ['effects']),
    };
    const reparsed = parser.parseAdjustmentModel(ser.serialize(patched)).model;
    // Target had 10; the source's default 0 must win.
    expect(reparsed.vignetteAmount ?? 0).toBe(0);
  });
});
