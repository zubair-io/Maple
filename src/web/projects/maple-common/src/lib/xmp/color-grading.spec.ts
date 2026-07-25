// color-grading.spec.ts — XMP round-trip for the colour-grading fields (#275).
//
// ACR's Color Grading panel writes the shadow/highlight hue+saturation
// pairs and the balance to `crs:SplitToning*` (covered by
// `s5-effects.spec.ts`) and namespaces the midtone zone, the per-zone
// luminance offsets and the global wheel under `crs:ColorGrade*`. This
// spec pins the second half, and mirrors the Swift
// `ColorGradingXMPTests`.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { defaultAdjustmentModel } from '../models/adjustment-model';

/** Every `crs:ColorGrade*` key paired with its model field and a value. */
const COLOR_GRADE_FIELDS = [
  ['crs:ColorGradeShadowLum', 'colorGradeShadowLuminance', 35],
  ['crs:ColorGradeMidtoneHue', 'colorGradeMidtoneHue', 150],
  ['crs:ColorGradeMidtoneSat', 'colorGradeMidtoneSaturation', 42],
  ['crs:ColorGradeMidtoneLum', 'colorGradeMidtoneLuminance', -28],
  ['crs:ColorGradeHighlightLum', 'colorGradeHighlightLuminance', -60],
  ['crs:ColorGradeGlobalHue', 'colorGradeGlobalHue', 300],
  ['crs:ColorGradeGlobalSat', 'colorGradeGlobalSaturation', 18],
  ['crs:ColorGradeGlobalLum', 'colorGradeGlobalLuminance', 12],
] as const;

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

describe('XMP colour-grading fields (#275)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it('parses every ACR `crs:ColorGrade*` key', () => {
    const attrs = COLOR_GRADE_FIELDS.map(([key, , value]) => `${key}="${value}"`).join('\n       ');
    const { model } = parser.parseAdjustmentModel(makeSidecar(attrs));
    for (const [key, field, value] of COLOR_GRADE_FIELDS) {
      expect(model[field], `${key} → ${field}`).toBe(value);
    }
  });

  it('round-trips every colour-grading field through serialize → parse', () => {
    const model = defaultAdjustmentModel();
    for (const [, field, value] of COLOR_GRADE_FIELDS) {
      model[field] = value;
    }
    // The five ACR-shared sliders ride along, since they are the same panel.
    model.splitToneShadowHue = 210;
    model.splitToneShadowSaturation = 44;
    model.splitToneHighlightHue = 45;
    model.splitToneHighlightSaturation = 22;
    model.splitToneBalance = -30;

    const xml = serializer.serialize(model);
    const { model: parsed } = parser.parseAdjustmentModel(xml);

    for (const [key, field, value] of COLOR_GRADE_FIELDS) {
      expect(xml, `${key} must be written`).toContain(key);
      expect(parsed[field], `${key} round-trip`).toBe(value);
    }
    expect(parsed.splitToneShadowHue).toBe(210);
    expect(parsed.splitToneShadowSaturation).toBe(44);
    expect(parsed.splitToneHighlightHue).toBe(45);
    expect(parsed.splitToneHighlightSaturation).toBe(22);
    expect(parsed.splitToneBalance).toBe(-30);
  });

  it('omits every colour-grading key for an all-default model', () => {
    const xml = serializer.serialize(defaultAdjustmentModel());
    for (const [key] of COLOR_GRADE_FIELDS) {
      expect(xml, `${key} must be omitted at default`).not.toContain(key);
    }
  });
});
