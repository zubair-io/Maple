// defringe.spec.ts — XMP round-trip for the profile-free lens corrections
// (#3411): `crs:AutoLateralCA` plus ACR's six `crs:Defringe*` controls.
//
// Mirrors the Rust arms in `raw-core/src/xmp/{mod,fields}.rs` and the Swift
// writer in `XMPSerialization+Attrs.swift`. The six numeric controls ride
// the generic `ADJUSTMENT_FIELDS` table, so `xmp-fields.spec.ts`'s
// round-trip loop already covers their plumbing; what needs its own
// coverage is the enum checkbox, ACR's "1"/"0" spelling of it, and the
// omit-at-default contract — which for the four hue-band edges means
// omitting at a NON-zero default (ACR's 30/70 and 40/60), the one thing
// this group does differently from every other numeric field.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { defaultAdjustmentModel } from '../models/adjustment-model';

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

describe('XMP profile-free lens corrections (#3411)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it("matches ACR's own out-of-the-box defringe panel", () => {
    const d = defaultAdjustmentModel();
    expect(d.autoLateralCa).toBe('Off');
    expect(d.defringePurpleAmount).toBe(0);
    expect(d.defringePurpleHueLo).toBe(30);
    expect(d.defringePurpleHueHi).toBe(70);
    expect(d.defringeGreenAmount).toBe(0);
    expect(d.defringeGreenHueLo).toBe(40);
    expect(d.defringeGreenHueHi).toBe(60);
  });

  describe('crs:AutoLateralCA', () => {
    it("parses ACR's 1/0 spelling and the boolean spelling, case-insensitively", () => {
      for (const on of ['1', 'true', 'True', 'On']) {
        const { model } = parser.parseAdjustmentModel(makeSidecar(`crs:AutoLateralCA="${on}"`));
        expect(model.autoLateralCa).toBe('On');
      }
      for (const off of ['0', 'false', 'False', 'Off']) {
        const { model } = parser.parseAdjustmentModel(makeSidecar(`crs:AutoLateralCA="${off}"`));
        expect(model.autoLateralCa).toBe('Off');
      }
    });

    it('drops unknown values so the field takes its default (Off)', () => {
      const { model } = parser.parseAdjustmentModel(makeSidecar(`crs:AutoLateralCA="Maybe"`));
      expect(model.autoLateralCa).toBeUndefined();
      const merged = { ...defaultAdjustmentModel(), ...model };
      expect(merged.autoLateralCa).toBe('Off');
    });

    it("serializes as ACR's 1 and round-trips", () => {
      const m = defaultAdjustmentModel();
      m.autoLateralCa = 'On';
      const xml = serializer.serialize(m);
      expect(xml).toContain('crs:AutoLateralCA="1"');
      const { model } = parser.parseAdjustmentModel(xml);
      expect(model.autoLateralCa).toBe('On');
    });

    it('omits the attribute at the default (Off)', () => {
      const xml = serializer.serialize(defaultAdjustmentModel());
      expect(xml).not.toContain('crs:AutoLateralCA');
    });
  });

  describe('crs:Defringe*', () => {
    it('round-trips both amounts and all four hue-band edges', () => {
      const m = defaultAdjustmentModel();
      m.defringePurpleAmount = 12;
      m.defringePurpleHueLo = 25;
      m.defringePurpleHueHi = 80;
      m.defringeGreenAmount = 7;
      m.defringeGreenHueLo = 35;
      m.defringeGreenHueHi = 65;
      const xml = serializer.serialize(m);

      const { model } = parser.parseAdjustmentModel(xml);
      expect(model.defringePurpleAmount).toBe(12);
      expect(model.defringePurpleHueLo).toBe(25);
      expect(model.defringePurpleHueHi).toBe(80);
      expect(model.defringeGreenAmount).toBe(7);
      expect(model.defringeGreenHueLo).toBe(35);
      expect(model.defringeGreenHueHi).toBe(65);
    });

    it('omits every control at its default, including the non-zero hue bands', () => {
      const xml = serializer.serialize(defaultAdjustmentModel());
      expect(xml).not.toContain('crs:Defringe');
    });

    it('writes only what moved when an amount is raised on ACR’s own band', () => {
      const m = defaultAdjustmentModel();
      m.defringePurpleAmount = 5;
      const xml = serializer.serialize(m);
      expect(xml).toContain('crs:DefringePurpleAmount=');
      expect(xml).not.toContain('crs:DefringePurpleHue');
      expect(xml).not.toContain('crs:DefringeGreen');
    });

    it('keeps the defringe attributes out of the passthrough bucket (no double-emit)', () => {
      const source = makeSidecar(`crs:AutoLateralCA="1" crs:DefringePurpleAmount="12"`);
      const { model, passthrough } = parser.parseAdjustmentModel(source);
      const merged = { ...defaultAdjustmentModel(), ...model };
      const xml = serializer.serialize(merged, passthrough);
      expect(xml.match(/crs:AutoLateralCA=/g)?.length).toBe(1);
      expect(xml.match(/crs:DefringePurpleAmount=/g)?.length).toBe(1);
    });
  });
});
