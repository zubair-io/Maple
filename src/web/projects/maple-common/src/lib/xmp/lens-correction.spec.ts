// lens-correction.spec.ts — XMP round-trip for the DNG lens-correction
// fields (#376): `crs:LensProfileEnable` plus the three
// `crs:LensProfile*Scale` strengths.
//
// Mirrors the Rust arms in `raw-core/src/xmp/mod.rs` and the Swift writer
// in `XMPSerialization+Attrs.swift`. The three scales ride the generic
// `ADJUSTMENT_FIELDS` numeric table, so `xmp-fields.spec.ts`'s round-trip
// loop already covers them; what needs its own coverage is the enum master
// switch, ACR's "1"/"0" spelling of it, and the omit-at-default contract
// that keeps sidecars from a build without a lens panel byte-identical.

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

describe('XMP DNG lens-correction fields (#376)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it('defaults to applying the DNG corrections at full strength', () => {
    const d = defaultAdjustmentModel();
    expect(d.lensProfileEnable).toBe('On');
    expect(d.lensCorrectionDistortion).toBe(100);
    expect(d.lensCorrectionCa).toBe(100);
    expect(d.lensCorrectionVignetting).toBe(100);
  });

  describe('crs:LensProfileEnable', () => {
    it("parses ACR's 1/0 spelling and the boolean spelling, case-insensitively", () => {
      for (const on of ['1', 'true', 'True', 'On']) {
        const { model } = parser.parseAdjustmentModel(makeSidecar(`crs:LensProfileEnable="${on}"`));
        expect(model.lensProfileEnable).toBe('On');
      }
      for (const off of ['0', 'false', 'False', 'Off']) {
        const { model } = parser.parseAdjustmentModel(
          makeSidecar(`crs:LensProfileEnable="${off}"`),
        );
        expect(model.lensProfileEnable).toBe('Off');
      }
    });

    it('drops unknown values so the field takes its default (On)', () => {
      const { model } = parser.parseAdjustmentModel(makeSidecar(`crs:LensProfileEnable="Maybe"`));
      expect(model.lensProfileEnable).toBeUndefined();
      const merged = { ...defaultAdjustmentModel(), ...model };
      expect(merged.lensProfileEnable).toBe('On');
    });

    it("serializes as ACR's 0 and round-trips", () => {
      const m = defaultAdjustmentModel();
      m.lensProfileEnable = 'Off';
      const xml = serializer.serialize(m);
      expect(xml).toContain('crs:LensProfileEnable="0"');
      const { model } = parser.parseAdjustmentModel(xml);
      expect(model.lensProfileEnable).toBe('Off');
    });

    it('omits the attribute at the default (On) so untouched sidecars stay byte-identical', () => {
      const xml = serializer.serialize(defaultAdjustmentModel());
      expect(xml).not.toContain('crs:LensProfileEnable');
    });
  });

  describe('crs:LensProfile*Scale', () => {
    it('parses and round-trips all three strengths', () => {
      const m = defaultAdjustmentModel();
      m.lensCorrectionDistortion = 80;
      m.lensCorrectionCa = 0;
      m.lensCorrectionVignetting = 55;
      const xml = serializer.serialize(m);
      expect(xml).toContain('crs:LensProfileDistortionScale=');
      expect(xml).toContain('crs:LensProfileChromaticAberrationScale=');
      expect(xml).toContain('crs:LensProfileVignettingScale=');

      const { model } = parser.parseAdjustmentModel(xml);
      expect(model.lensCorrectionDistortion).toBe(80);
      expect(model.lensCorrectionCa).toBe(0);
      expect(model.lensCorrectionVignetting).toBe(55);
    });

    it('omits the scales at their full-strength default', () => {
      const xml = serializer.serialize(defaultAdjustmentModel());
      expect(xml).not.toContain('crs:LensProfileDistortionScale');
      expect(xml).not.toContain('crs:LensProfileChromaticAberrationScale');
      expect(xml).not.toContain('crs:LensProfileVignettingScale');
    });

    it('keeps the lens attributes out of the passthrough bucket (no double-emit)', () => {
      const source = makeSidecar(`crs:LensProfileEnable="0" crs:LensProfileDistortionScale="40"`);
      const { model, passthrough } = parser.parseAdjustmentModel(source);
      const merged = { ...defaultAdjustmentModel(), ...model };
      const xml = serializer.serialize(merged, passthrough);
      expect(xml.match(/crs:LensProfileEnable=/g)?.length).toBe(1);
      expect(xml.match(/crs:LensProfileDistortionScale=/g)?.length).toBe(1);
    });
  });
});
