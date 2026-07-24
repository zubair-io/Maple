// enum-modes.spec.ts — XMP round-trip for the enum mode fields that were
// missing from the TS serializer/parser (#2214): `papp:AutoExposure`,
// `papp:HighlightRecoveryMode`, `papp:WbMethod`, `papp:ToneCurveMode`.
//
// Mirrors the Swift tests in
// `src/apple/Packages/MapleCore/Tests/MapleCoreTests/XMPSerializationTests.swift`
// (autoExposure half added by PR #2205) and the Rust parse arms in
// `raw-core/src/xmp/mod.rs` — each attribute parses case-insensitively,
// serializes only when non-default, and unknown values fall back to the
// default instead of blocking sidecar load. Same contract as the
// established `papp:HotPixelSuppression` wiring (`hot-pixel.spec.ts`).

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

describe('XMP enum mode fields (#2214)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  // ── papp:AutoExposure (#1387 web half) ────────────────────────────────────

  describe('papp:AutoExposure', () => {
    it('parses case-insensitively', () => {
      const { model } = parser.parseAdjustmentModel(makeSidecar(`papp:AutoExposure="Off"`));
      expect(model.autoExposure).toBe('Off');
      const { model: m2 } = parser.parseAdjustmentModel(makeSidecar(`papp:AutoExposure="on"`));
      expect(m2.autoExposure).toBe('On');
    });

    it('drops unknown values so the field takes its default (On)', () => {
      const { model } = parser.parseAdjustmentModel(makeSidecar(`papp:AutoExposure="Maybe"`));
      expect(model.autoExposure).toBeUndefined();
      const merged = { ...defaultAdjustmentModel(), ...model };
      expect(merged.autoExposure).toBe('On');
    });

    it('round-trips a non-default value through serialize → parse', () => {
      const m = defaultAdjustmentModel();
      m.autoExposure = 'Off';
      const xml = serializer.serialize(m);
      expect(xml).toContain('papp:AutoExposure="Off"');
      const { model } = parser.parseAdjustmentModel(xml);
      expect(model.autoExposure).toBe('Off');
    });

    it('omits `papp:AutoExposure` at the default (On) so pre-#1387 sidecars stay byte-identical', () => {
      const xml = serializer.serialize(defaultAdjustmentModel());
      expect(xml).not.toContain('papp:AutoExposure');
    });
  });

  // ── papp:HighlightRecoveryMode ────────────────────────────────────────────

  describe('papp:HighlightRecoveryMode', () => {
    it('parses every variant case-insensitively', () => {
      for (const [wire, expected] of [
        ['Off', 'Off'],
        ['blend', 'Blend'],
        ['Luminance', 'Luminance'],
        ['chromaticadaptation', 'ChromaticAdaptation'],
        ['OklabChromaReduction', 'OklabChromaReduction'],
      ] as const) {
        const { model } = parser.parseAdjustmentModel(
          makeSidecar(`papp:HighlightRecoveryMode="${wire}"`),
        );
        expect(model.highlightRecovery).toBe(expected);
      }
    });

    it('drops unknown values so the field takes its default (ChromaticAdaptation)', () => {
      const { model } = parser.parseAdjustmentModel(
        makeSidecar(`papp:HighlightRecoveryMode="Magic"`),
      );
      expect(model.highlightRecovery).toBeUndefined();
      const merged = { ...defaultAdjustmentModel(), ...model };
      expect(merged.highlightRecovery).toBe('ChromaticAdaptation');
    });

    it('round-trips a non-default value through serialize → parse', () => {
      const m = defaultAdjustmentModel();
      m.highlightRecovery = 'Blend';
      const xml = serializer.serialize(m);
      expect(xml).toContain('papp:HighlightRecoveryMode="Blend"');
      const { model } = parser.parseAdjustmentModel(xml);
      expect(model.highlightRecovery).toBe('Blend');
    });

    it('omits `papp:HighlightRecoveryMode` at the default', () => {
      const xml = serializer.serialize(defaultAdjustmentModel());
      expect(xml).not.toContain('papp:HighlightRecoveryMode');
    });
  });

  // ── papp:WbMethod (#431) ──────────────────────────────────────────────────

  describe('papp:WbMethod', () => {
    it('parses case-insensitively, including the CAT16 spelling raw-core accepts', () => {
      const { model } = parser.parseAdjustmentModel(makeSidecar(`papp:WbMethod="DiagonalRec2020"`));
      expect(model.wbMethod).toBe('DiagonalRec2020');
      const { model: m2 } = parser.parseAdjustmentModel(makeSidecar(`papp:WbMethod="CAT16"`));
      expect(m2.wbMethod).toBe('Cat16');
    });

    it('drops unknown values so the field takes its default (Cat16)', () => {
      const { model } = parser.parseAdjustmentModel(makeSidecar(`papp:WbMethod="Bradford"`));
      expect(model.wbMethod).toBeUndefined();
      const merged = { ...defaultAdjustmentModel(), ...model };
      expect(merged.wbMethod).toBe('Cat16');
    });

    it('round-trips a non-default value through serialize → parse', () => {
      const m = defaultAdjustmentModel();
      m.wbMethod = 'DiagonalRec2020';
      const xml = serializer.serialize(m);
      expect(xml).toContain('papp:WbMethod="DiagonalRec2020"');
      const { model } = parser.parseAdjustmentModel(xml);
      expect(model.wbMethod).toBe('DiagonalRec2020');
    });

    it('omits `papp:WbMethod` at the default', () => {
      const xml = serializer.serialize(defaultAdjustmentModel());
      expect(xml).not.toContain('papp:WbMethod');
    });
  });

  // ── papp:ToneCurveMode (#436) ─────────────────────────────────────────────

  describe('papp:ToneCurveMode', () => {
    it('parses case-insensitively', () => {
      const { model } = parser.parseAdjustmentModel(
        makeSidecar(`papp:ToneCurveMode="RatioPreserving"`),
      );
      expect(model.toneCurveMode).toBe('RatioPreserving');
      const { model: m2 } = parser.parseAdjustmentModel(
        makeSidecar(`papp:ToneCurveMode="perchannel"`),
      );
      expect(m2.toneCurveMode).toBe('PerChannel');
    });

    it('drops unknown values so the field takes its default (PerChannel)', () => {
      const { model } = parser.parseAdjustmentModel(makeSidecar(`papp:ToneCurveMode="Filmic"`));
      expect(model.toneCurveMode).toBeUndefined();
      const merged = { ...defaultAdjustmentModel(), ...model };
      expect(merged.toneCurveMode).toBe('PerChannel');
    });

    it('round-trips a non-default value through serialize → parse', () => {
      const m = defaultAdjustmentModel();
      m.toneCurveMode = 'RatioPreserving';
      const xml = serializer.serialize(m);
      expect(xml).toContain('papp:ToneCurveMode="RatioPreserving"');
      const { model } = parser.parseAdjustmentModel(xml);
      expect(model.toneCurveMode).toBe('RatioPreserving');
    });

    it('omits `papp:ToneCurveMode` at the default', () => {
      const xml = serializer.serialize(defaultAdjustmentModel());
      expect(xml).not.toContain('papp:ToneCurveMode');
    });
  });

  // ── Passthrough interaction ───────────────────────────────────────────────

  it('emits each parsed enum attribute exactly once on re-save (no passthrough double-emit)', () => {
    // Before #2214 these attributes survived a web save only via the
    // unknown-attribute passthrough bucket. Now that they parse into the
    // model AND serialize from it, they must be claimed as known attributes
    // — otherwise a load → save cycle would emit them twice (once from the
    // model, once verbatim from passthrough).
    const source = makeSidecar(
      [
        `papp:AutoExposure="Off"`,
        `papp:HighlightRecoveryMode="Blend"`,
        `papp:WbMethod="DiagonalRec2020"`,
        `papp:ToneCurveMode="RatioPreserving"`,
      ].join('\n    '),
    );
    const { model, passthrough } = parser.parseAdjustmentModel(source);
    expect(passthrough.unknownAttributes).toEqual([]);

    const merged = { ...defaultAdjustmentModel(), ...model };
    const xml = serializer.serialize(merged, passthrough);
    for (const attr of [
      'papp:AutoExposure',
      'papp:HighlightRecoveryMode',
      'papp:WbMethod',
      'papp:ToneCurveMode',
    ]) {
      const count = xml.split(`${attr}=`).length - 1;
      expect(count, `${attr} must appear exactly once`).toBe(1);
    }
  });
});
