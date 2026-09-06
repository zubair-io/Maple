import { describe, expect, it } from 'vitest';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { buildGroupPatch } from './adjustment-groups';
import { buildXmpTransferPatch } from './xmp-transfer-patch';
import { ADJUSTMENT_FIELDS } from '../../xmp/xmp-fields';
import { TRANSFER_XMP_ATTRIBUTES } from '../../generated/adjustment-transfer.generated';
import { camelToSnakeField } from '../presets/preset-model';

const serializer = new XmpSerializerService();
describe('serialized transfer wire contract', () => {
  it('keeps the shared attribute mapping aligned with every Web numeric field', () => {
    for (const field of ADJUSTMENT_FIELDS) {
      expect(TRANSFER_XMP_ATTRIBUTES[camelToSnakeField(field.modelKey)], field.modelKey).toContain(
        field.xmpKey,
      );
    }
  });
  it('uses null to reset omitted defaults and preserves normalized crop coordinates', () => {
    const source = {
      ...defaultAdjustmentModel(),
      crop: { top: 0.1, left: 0.2, bottom: 0.9, right: 0.8, angle: 3 },
    };
    const patch = buildGroupPatch(source, ['tone', 'geometry']);
    const wire = buildXmpTransferPatch(patch, serializer.serialize(source));
    expect(wire.attributes['crs:Exposure2012']).toBeNull();
    expect(wire.attributes['crs:CropTop']).toBe('0.100000');
    expect(wire.attributes['crs:Temperature']).toBeUndefined();
  });
  it('withholds As Shot display seeds and clears target-only WB sample provenance', () => {
    const source = { ...defaultAdjustmentModel(), temperature: 7000, tint: 15 };
    const patch = buildGroupPatch(source, ['white_balance']);
    const wire = buildXmpTransferPatch(patch, serializer.serialize({ ...source, ...patch }));
    expect(wire.attributes['crs:Temperature']).toBeNull();
    expect(wire.attributes['crs:Tint']).toBeNull();
    expect(wire.attributes['papp:WbSampleX']).toBeNull();
    expect(wire.attributes['papp:WbAlgorithmVersion']).toBeNull();
  });
  it('serializes non-identity curves as independently namespace-valid fragments', () => {
    const source = defaultAdjustmentModel();
    source.toneCurveLuma = {
      points: [
        [0, 0],
        [0.5, 0.7],
        [1, 1],
      ],
    };
    const patch = buildGroupPatch(source, ['tone']);
    const wire = buildXmpTransferPatch(patch, serializer.serialize(source));
    const curve = wire.elements['papp:SceneLinearToneCurve'];
    expect(curve).toBeTruthy();
    expect(
      new DOMParser().parseFromString(curve!, 'application/xml').querySelector('parsererror'),
    ).toBeNull();
    expect(wire.elements['papp:SceneLinearToneCurveRed']).toBeNull();
  });
});
