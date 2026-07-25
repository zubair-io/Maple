// black-white.spec.ts — XMP round-trip for the B&W toggle + gray-mixer
// weights (#276): `crs:ConvertToGrayscale` and `crs:GrayMixerRed` …
// `crs:GrayMixerMagenta`.
//
// Mirrors `enum-modes.spec.ts`'s pattern (parse case-insensitively, drop
// unknown values to the default, round-trip non-default values, omit at
// default) for the toggle, plus the generic numeric-field round-trip
// pattern from `xmp-fields.spec.ts` for the 8 weights.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';

function makeSidecar(attrs: string): string {
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmlns:papp="http://ns.justmaple.app/photo/1.0/"
    crs:Version="11.0"
    ${attrs}>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

const GRAY_MIXER_FIELDS = [
  'grayMixerRed',
  'grayMixerOrange',
  'grayMixerYellow',
  'grayMixerGreen',
  'grayMixerAqua',
  'grayMixerBlue',
  'grayMixerPurple',
  'grayMixerMagenta',
] as const satisfies readonly (keyof AdjustmentModel)[];

const GRAY_MIXER_XMP_KEYS: Record<(typeof GRAY_MIXER_FIELDS)[number], string> = {
  grayMixerRed: 'crs:GrayMixerRed',
  grayMixerOrange: 'crs:GrayMixerOrange',
  grayMixerYellow: 'crs:GrayMixerYellow',
  grayMixerGreen: 'crs:GrayMixerGreen',
  grayMixerAqua: 'crs:GrayMixerAqua',
  grayMixerBlue: 'crs:GrayMixerBlue',
  grayMixerPurple: 'crs:GrayMixerPurple',
  grayMixerMagenta: 'crs:GrayMixerMagenta',
};

describe('XMP black & white fields (#276)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  // ── crs:ConvertToGrayscale (the toggle) ───────────────────────────────────

  describe('crs:ConvertToGrayscale', () => {
    it('parses "True"/"true"/"1" as On and "False"/"false"/"0" as Off', () => {
      for (const wire of ['True', 'true', '1']) {
        const { model } = parser.parseAdjustmentModel(
          makeSidecar(`crs:ConvertToGrayscale="${wire}"`),
        );
        expect(model.blackWhite).toBe('On');
      }
      for (const wire of ['False', 'false', '0']) {
        const { model } = parser.parseAdjustmentModel(
          makeSidecar(`crs:ConvertToGrayscale="${wire}"`),
        );
        expect(model.blackWhite).toBe('Off');
      }
    });

    it('drops unknown values so the field takes its default (Off)', () => {
      const { model } = parser.parseAdjustmentModel(makeSidecar(`crs:ConvertToGrayscale="Maybe"`));
      expect(model.blackWhite).toBeUndefined();
      const merged = { ...defaultAdjustmentModel(), ...model };
      expect(merged.blackWhite).toBe('Off');
    });

    it('round-trips On through a genuine write → parse cycle', () => {
      const m = defaultAdjustmentModel();
      m.blackWhite = 'On';
      const xml = serializer.serialize(m);
      expect(xml).toContain('crs:ConvertToGrayscale="True"');
      const { model } = parser.parseAdjustmentModel(xml);
      expect(model.blackWhite).toBe('On');
    });

    it('omits `crs:ConvertToGrayscale` at the default (Off) so sidecars stay byte-identical', () => {
      const xml = serializer.serialize(defaultAdjustmentModel());
      expect(xml).not.toContain('crs:ConvertToGrayscale');
    });

    it('is claimed as a known attribute so a load → save cycle does not double-emit it via passthrough', () => {
      const { model, passthrough } = parser.parseAdjustmentModel(
        makeSidecar(`crs:ConvertToGrayscale="True"`),
      );
      expect(passthrough.unknownAttributes).toEqual([]);
      const merged = { ...defaultAdjustmentModel(), ...model };
      const xml = serializer.serialize(merged, passthrough);
      const count = xml.split('crs:ConvertToGrayscale=').length - 1;
      expect(count).toBe(1);
    });
  });

  // ── crs:GrayMixerRed … crs:GrayMixerMagenta (the 8 weights) ──────────────

  describe('crs:GrayMixerX weights', () => {
    it('round-trips a genuine write → parse cycle for all 8 bands with distinct values', () => {
      const model = defaultAdjustmentModel();
      model.blackWhite = 'On';
      GRAY_MIXER_FIELDS.forEach((field, i) => {
        (model as unknown as Record<string, number>)[field] = -70 + i * 20; // distinct, non-default
      });
      const xml = serializer.serialize(model);
      for (const field of GRAY_MIXER_FIELDS) {
        expect(xml).toContain(`${GRAY_MIXER_XMP_KEYS[field]}=`);
      }
      const { model: parsed } = parser.parseAdjustmentModel(xml);
      const merged = { ...defaultAdjustmentModel(), ...parsed } as unknown as Record<
        string,
        number
      >;
      GRAY_MIXER_FIELDS.forEach((field, i) => {
        expect(merged[field]).toBe(-70 + i * 20);
      });
    });

    it('omits all 8 gray-mixer keys from a default sidecar', () => {
      const xml = serializer.serialize(defaultAdjustmentModel());
      for (const field of GRAY_MIXER_FIELDS) {
        expect(xml).not.toContain(`${GRAY_MIXER_XMP_KEYS[field]}=`);
      }
    });

    it('preserves a single non-default weight (Red) across a round-trip', () => {
      const model = defaultAdjustmentModel();
      model.grayMixerRed = 42;
      const xml = serializer.serialize(model);
      expect(xml).toContain('crs:GrayMixerRed="42"');
      const { model: parsed } = parser.parseAdjustmentModel(xml);
      expect(parsed.grayMixerRed).toBe(42);
    });
  });
});
