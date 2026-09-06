// @vitest-environment jsdom
// The edit-transaction value type (#2432): the deterministic sidecar diff,
// the invalidation classifier, the no-op rule, and the bounded, versioned
// wire form — pinned byte-equal to Apple's `EditTransactionTests`.
import { describe, expect, it } from 'vitest';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';
import {
  EDIT_TRANSACTION_VERSION,
  type EditTransactionKind,
  classifyInvalidation,
  makeEditTransaction,
  serializeEditTransaction,
  sidecarDiff,
} from './edit-transaction';

const serializer = new XmpSerializerService();

function tx(
  before: AdjustmentModel,
  after: AdjustmentModel,
  kind: EditTransactionKind = 'adjustment',
) {
  return makeEditTransaction(serializer, { id: 1, kind, description: 't', before, after });
}

describe('edit transaction', () => {
  it('is not created for a no-op', () => {
    expect(tx(defaultAdjustmentModel(), defaultAdjustmentModel())).toBeNull();
  });

  it('carries a deterministic, sorted, canonical sidecar diff', () => {
    const after = { ...defaultAdjustmentModel(), exposure: 0.5, contrast: 12 };
    const a = tx(defaultAdjustmentModel(), after)!;
    const b = tx(defaultAdjustmentModel(), after)!;
    expect(a.diff).toEqual(b.diff);
    expect(a.diff.map((c) => c.key)).toEqual(['crs:Contrast2012', 'crs:Exposure2012']);
    // Values are the canonical sidecar attribute strings — the same bytes the
    // XMP writer emits, so Apple's diff over the same models is identical.
    // `before` is null, not '0': omit-on-default on both platforms (the
    // Apple side subtracts its unconditional core-block emission).
    expect(a.diff[1]).toEqual({ key: 'crs:Exposure2012', before: null, after: '0.5' });
    expect(a.invalidation).toBe('develop');
  });

  it('diffs omitted-on-default attributes as absent', () => {
    const after = { ...defaultAdjustmentModel(), brightness: 10 };
    expect(sidecarDiff(serializer, defaultAdjustmentModel(), after)).toEqual([
      { key: 'papp:Brightness', before: null, after: '10' },
    ]);
  });

  it('includes tone-curve changes in the diff', () => {
    const after = {
      ...defaultAdjustmentModel(),
      toneCurveLuma: {
        points: [
          [0, 0],
          [128, 160],
          [255, 255],
        ] as [number, number][],
      },
    };
    const t = tx(defaultAdjustmentModel(), after)!;
    expect(t.diff.map((c) => c.key)).toEqual(['toneCurves']);
    expect(t.diff[0].before).toBeNull();
    expect(t.diff[0].after).toContain('papp:SceneLinearToneCurve');
  });

  it('classifies the invalidation scope', () => {
    const base = defaultAdjustmentModel();
    const cropOnly = { ...base, crop: { top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 0 } };
    expect(classifyInvalidation(base, cropOnly)).toBe('crop');
    expect(classifyInvalidation(base, { ...base, saturation: 30 })).toBe('develop');
    expect(classifyInvalidation(base, { ...base, deepDenoise: 40 })).toBe('decode');
    expect(classifyInvalidation(base, { ...base, lensProfile: `lcp1:${'a'.repeat(64)}` })).toBe(
      'decode',
    );
    expect(classifyInvalidation(base, { ...cropOnly, exposure: 1 })).toBe('develop');
    expect(classifyInvalidation(base, base)).toBe('none');
    expect(tx(base, cropOnly, 'crop')?.invalidation).toBe('crop');
  });

  it('serializes to the versioned, bounded, platform-identical wire form', () => {
    const after = { ...defaultAdjustmentModel(), exposure: 0.5 };
    const t = tx(defaultAdjustmentModel(), after)!;
    expect(EDIT_TRANSACTION_VERSION).toBe(1);
    // Pinned in Apple's EditTransactionTests.testSerializedFormIsVersionedBoundedAndPlatformIdentical.
    expect(serializeEditTransaction(t)).toBe(
      '{"description":"t","diff":[{"after":"0.5","before":null,"key":"crs:Exposure2012"}],"id":1,"invalidation":"develop","kind":"adjustment","version":1}',
    );
    const parsed = JSON.parse(serializeEditTransaction(t));
    expect(parsed.before).toBeUndefined();
    expect(parsed.after).toBeUndefined();
    expect(t.diff.length).toBeLessThanOrEqual(serializer.modelAttributes(after).size + 1);
  });

  it('round-trips the committed state through real XMP text', () => {
    // "Reloaded semantic state matches the committed state": serialize
    // `after` exactly as the sidecar writer would, parse it back, and the
    // sidecar diff between the two is empty.
    const after = {
      ...defaultAdjustmentModel(),
      exposure: 1.25,
      contrast: -15,
      brightness: 8,
      whiteBalancePreset: 'Custom' as const,
      temperature: 5200,
      tint: -3,
      crop: { top: 0.05, left: 0.1, bottom: 0.95, right: 0.9, angle: 1.5 },
    };
    const xml = serializer.serialize(after);
    const reloaded = {
      ...defaultAdjustmentModel(),
      ...new XmpParserService().parseAdjustmentModel(xml).model,
    };
    expect(sidecarDiff(serializer, after, reloaded)).toEqual([]);
  });
});
