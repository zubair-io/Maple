// local-adjustments-spatial.spec.ts — the six per-mask SPATIAL controls'
// XMP contract (#3407): Adobe's ±1 fraction scale, omit-on-default, and the
// `crs:CorrectionAmount` scaling. A sibling suite so `local-adjustments.spec.ts`
// stays inside the file-size budget — the same split raw-core makes with
// `tests_local_adjustments_spatial.rs`, whose assertions these mirror.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { localAdjustmentBlocks } from './xmp-local-adjustments';
import type { LocalAdjustment } from '../models/adjustment-model';
import {
  CANONICAL_INDENT,
  FULL_FRAME_GRADIENT,
  LINEAR_LAYER,
  SPATIAL_KEYS,
  gradientCorrection,
  sidecar,
  withLayers,
} from './local-adjustments.test-helpers';

describe('XMP local adjustments — spatial controls (#3407)', () => {
  let parser: XmpParserService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
  });

  it('round-trips a Lightroom-authored spatial correction byte-for-byte', () => {
    // Mirrors raw-core's `a_lightroom_authored_spatial_correction_round_trips
    // _byte_for_byte`: Adobe stores these six as ±1 fractions, so
    // `crs:LocalClarity2012="0.35"` is a Clarity of +35 and must come back
    // out as "0.35" — not "0.35000001", and not "35".
    const block = [
      '      <crs:CircularGradientBasedCorrections>',
      '        <rdf:Seq>',
      '          <rdf:li>',
      '            <rdf:Description',
      '              crs:What="Correction"',
      '              crs:CorrectionAmount="1"',
      '              crs:CorrectionActive="True"',
      '              crs:LocalTexture="0.2"',
      '              crs:LocalClarity2012="0.35"',
      '              crs:LocalDehaze="-0.4"',
      '              crs:LocalSharpness="0.55"',
      '              crs:LocalLuminanceNoise="0.3"',
      '              crs:LocalDefringe="0.65">',
      '              <crs:CorrectionMasks>',
      '                <rdf:Seq>',
      '                  <rdf:li',
      '                    crs:What="Mask/CircularGradient"',
      '                    crs:MaskValue="1"',
      '                    crs:Top="0.25" crs:Left="0.25" crs:Bottom="0.75" crs:Right="0.75"',
      '                    crs:Angle="0" crs:Midpoint="50" crs:Roundness="0"',
      '                    crs:Feather="50" crs:Flipped="False"/>',
      '                </rdf:Seq>',
      '              </crs:CorrectionMasks>',
      '            </rdf:Description>',
      '          </rdf:li>',
      '        </rdf:Seq>',
      '      </crs:CircularGradientBasedCorrections>',
    ].join('\n');
    const { model } = parser.parseAdjustmentModel(sidecar(block));
    const adjustments = model.localAdjustments?.[0].adjustments ?? {};
    // The ×100 lift out of Adobe's fraction scale is a float multiply, so the
    // slider values are compared within noise (0.55 × 100 is 55.00000000000001,
    // exactly as raw-core's sibling test allows for f32). The byte-for-byte
    // assertion below is what pins the WIRE, and the four-decimal rounding in
    // `fractionSerializer` is what makes that noise invisible to it.
    for (const [field, want] of [
      ['texture', 20],
      ['clarity', 35],
      ['dehaze', -40],
      ['sharpness', 55],
      ['luminanceNoise', 30],
      ['defringe', 65],
    ] as const) {
      expect(adjustments[field]).toBeCloseTo(want, 4);
    }
    expect(Object.keys(adjustments).sort()).toEqual(
      ['clarity', 'defringe', 'dehaze', 'luminanceNoise', 'sharpness', 'texture'].sort(),
    );
    expect(localAdjustmentBlocks(model, CANONICAL_INDENT)).toBe(block);
  });

  it('emits no spatial attributes for a layer that sets none of the six', () => {
    const layer: LocalAdjustment = { ...LINEAR_LAYER, adjustments: { exposure: 0.25 } };
    const block = localAdjustmentBlocks(withLayers([layer]), CANONICAL_INDENT);
    for (const key of SPATIAL_KEYS) expect(block).not.toContain(key);
    const { model } = parser.parseAdjustmentModel(sidecar(block));
    expect(model.localAdjustments?.[0].adjustments).toEqual({ exposure: 0.25 });
  });

  it('scales the spatial controls by crs:CorrectionAmount, like every other delta', () => {
    const doc = sidecar(
      gradientCorrection(
        'crs:What="Correction" crs:CorrectionAmount="0.5" crs:LocalClarity2012="0.4" crs:LocalDefringe="0.6"',
        FULL_FRAME_GRADIENT,
      ),
    );
    const { model } = parser.parseAdjustmentModel(doc);
    expect(model.localAdjustments?.[0].adjustments).toEqual({ clarity: 20, defringe: 30 });
  });

  it('keeps a spatial control at 0 distinct from an unset one', () => {
    // `texture: 0` is "the mask sets Texture, to zero" — a real state a user
    // can dial back to — and must survive the round trip as an emitted
    // "0", never collapse into the omit-on-default silence above.
    const layer: LocalAdjustment = { ...LINEAR_LAYER, adjustments: { texture: 0 } };
    const block = localAdjustmentBlocks(withLayers([layer]), CANONICAL_INDENT);
    expect(block).toContain('crs:LocalTexture="0"');
    const { model } = parser.parseAdjustmentModel(sidecar(block));
    expect(model.localAdjustments?.[0].adjustments).toEqual({ texture: 0 });
  });
});
