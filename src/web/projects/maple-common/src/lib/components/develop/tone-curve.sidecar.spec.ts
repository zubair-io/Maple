// tone-curve.sidecar.spec.ts — the editor → sidecar join (#367).
//
// #365 pins the XMP encoding itself and `tone-curve.spec.ts` pins the
// editing rules. What this file adds is the join between them: that a curve
// authored the way the WIDGET authors one — through `tone-curve-edit`, not a
// hand-written point list — survives a real serialize/parse cycle, and that
// the identity collapse genuinely leaves the file free of a curve block
// rather than writing a flat one.
//
// The Swift twin is `ToneCurveMathTests.testCurveAuthoredThroughTheEditing…`.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from '../../xmp/xmp-parser.service';
import { XmpSerializerService } from '../../xmp/xmp-serializer.service';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import { insertPoint, movePoint, removePoint } from './tone-curve-edit';

describe('tone curve editor → sidecar (#367)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it('round-trips a curve authored through the editing helpers', () => {
    // Author exactly as the plot does: click to insert, drag to move.
    const authored = movePoint(insertPoint([], 0.25, 0.15), 1, 0.6, 0.72);

    const xml = serializer.serialize({
      ...defaultAdjustmentModel(),
      toneCurveLuma: { points: authored },
      toneCurveGreen: { points: insertPoint([], 0.5, 0.35) },
      parametricLights: 24,
    });

    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.toneCurveLuma?.points.length).toBe(3);
    expect(model.toneCurveLuma?.points[1][0]).toBeCloseTo(0.6, 2);
    expect(model.toneCurveLuma?.points[1][1]).toBeCloseTo(0.72, 2);
    expect(model.toneCurveGreen?.points.length).toBe(3);
    expect(model.parametricLights).toBeCloseTo(24, 6);

    // Untouched channels must not reach the file at all.
    expect(xml).toContain('papp:SceneLinearToneCurve>');
    expect(xml).not.toContain('papp:SceneLinearToneCurveRed');
    expect(xml).not.toContain('papp:SceneLinearToneCurveBlue');
  });

  it('leaves no block behind once the last authored knot is removed', () => {
    const authored = insertPoint([], 0.4, 0.6);
    expect(
      serializer.serialize({
        ...defaultAdjustmentModel(),
        toneCurveLuma: { points: authored },
      }),
    ).toContain('papp:SceneLinearToneCurve');

    // Deleting the one knot the user added collapses to the EMPTY identity.
    const reset = removePoint(authored, 1);
    expect(reset).toEqual([]);

    const xml = serializer.serialize({
      ...defaultAdjustmentModel(),
      toneCurveLuma: { points: reset },
    });
    expect(xml).not.toContain('papp:SceneLinearToneCurve');
    expect(xml).toBe(serializer.serialize(defaultAdjustmentModel()));
  });

  it('keeps the four channels independent through a cycle', () => {
    const xml = serializer.serialize({
      ...defaultAdjustmentModel(),
      toneCurveRed: { points: insertPoint([], 0.3, 0.45) },
      toneCurveBlue: { points: insertPoint([], 0.7, 0.55) },
    });
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.toneCurveRed?.points.length).toBe(3);
    expect(model.toneCurveBlue?.points.length).toBe(3);
    expect(model.toneCurveLuma).toBeUndefined();
    expect(model.toneCurveGreen).toBeUndefined();
  });
});
