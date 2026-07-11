// xmp-fields.spec.ts — guards that every XMP write-omit sentinel matches the
// canonical model default, and that all numeric fields round-trip through the
// serializer/parser.
//
// Regression coverage for #953: the `crs:Sharpness` / `crs:SharpenRadius`
// sentinels had drifted from the model defaults (0 / 0.5 vs 40 / 1.0), so a
// user's Sharpen Amount = 0 was omitted on write and silently read back as 40.

import { describe, it, expect } from 'vitest';

import { ADJUSTMENT_FIELDS } from './xmp-fields';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';

// The XMP services are dependency-free (`@Injectable` with no constructor
// injection), so they instantiate directly here without an Angular TestBed.
const serializer = new XmpSerializerService();
const parser = new XmpParserService();

/** Serialize then parse, merging over defaults the way real callers do. */
function roundTrip(model: AdjustmentModel): AdjustmentModel {
  const xml = serializer.serialize(model);
  return { ...defaultAdjustmentModel(), ...parser.parseAdjustmentModel(xml).model };
}

describe('XMP field defaults', () => {
  it('every write-omit sentinel equals the model default for its field', () => {
    const d = defaultAdjustmentModel();
    for (const f of ADJUSTMENT_FIELDS) {
      expect(f.defaultValue(d)).toBe(d[f.modelKey]);
    }
  });
});

describe('XMP numeric round-trip', () => {
  it('round-trips every numeric field via its xmpKey↔modelKey mapping', () => {
    // Distinct value per field so a transposed xmpKey/modelKey pair is caught.
    const writable = defaultAdjustmentModel() as unknown as Record<string, number>;
    ADJUSTMENT_FIELDS.forEach((f, i) => {
      writable[f.modelKey] = i + 1;
    });
    // The temperature/tint values here are authored, not the As-Shot display
    // seed — mark the model Custom or the serializer omits them (#1892).
    (writable as unknown as AdjustmentModel).whiteBalancePreset = 'Custom';
    const out = roundTrip(writable as unknown as AdjustmentModel);
    ADJUSTMENT_FIELDS.forEach((f, i) => {
      expect(out[f.modelKey]).toBe(i + 1);
    });
  });

  // #953: Sharpen Amount = 0 (sharpening off) must survive a write/read cycle.
  // Before the fix the 0-sentinel omitted it on write and it read back as 40.
  it('preserves Sharpen Amount = 0 across a round-trip (regressed to 40 before #953)', () => {
    const model = defaultAdjustmentModel();
    model.sharpenAmount = 0;
    expect(roundTrip(model).sharpenAmount).toBe(0);
  });

  it('preserves Sharpen Radius = 0.5 across a round-trip (regressed to 1.0 before #953)', () => {
    const model = defaultAdjustmentModel();
    model.sharpenRadius = 0.5;
    expect(roundTrip(model).sharpenRadius).toBe(0.5);
  });

  it('omits crs:Sharpness / crs:SharpenRadius from a default sidecar (now 40 / 1.0)', () => {
    const xml = serializer.serialize(defaultAdjustmentModel());
    expect(xml).not.toContain('crs:Sharpness=');
    expect(xml).not.toContain('crs:SharpenRadius=');
  });
});
