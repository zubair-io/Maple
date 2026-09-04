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

  // ── papp:WbSource (#2434) ─────────────────────────────────────────────────

  describe('papp:WbSource', () => {
    it('parses every variant case-insensitively', () => {
      for (const [wire, want] of [
        ['AsShot', 'AsShot'],
        ['auto', 'Auto'],
        ['Preset', 'Preset'],
        ['sampled', 'Sampled'],
        ['Manual', 'Manual'],
      ] as const) {
        const { model } = parser.parseAdjustmentModel(makeSidecar(`papp:WbSource="${wire}"`));
        expect(model.wbSource).toBe(want);
      }
    });

    it('drops unknown values so the field takes its default (AsShot)', () => {
      const { model } = parser.parseAdjustmentModel(makeSidecar(`papp:WbSource="Eyeballed"`));
      expect(model.wbSource).toBeUndefined();
      expect({ ...defaultAdjustmentModel(), ...model }.wbSource).toBe('AsShot');
    });

    it('round-trips a sampled pair with its point and algorithm version', () => {
      const m = defaultAdjustmentModel();
      m.wbSource = 'Sampled';
      m.wbSampleX = 0.25;
      m.wbSampleY = 0.75;
      m.wbAlgorithmVersion = 1;
      const xml = serializer.serialize(m);
      expect(xml).toContain('papp:WbSource="Sampled"');
      expect(xml).toContain('papp:WbSampleX="0.25"');
      expect(xml).toContain('papp:WbSampleY="0.75"');
      expect(xml).toContain('papp:WbAlgorithmVersion="1"');
      const { model } = parser.parseAdjustmentModel(xml);
      expect(model.wbSource).toBe('Sampled');
      expect(model.wbSampleX).toBe(0.25);
      expect(model.wbSampleY).toBe(0.75);
      expect(model.wbAlgorithmVersion).toBe(1);
    });

    it('never writes provenance detail the pair was not actually derived from (#3309)', () => {
      // A `Sampled` source with no derivation version is a label a paste
      // carried, not provenance: writing `0,0` would claim a sample that
      // never happened.
      const pasted = defaultAdjustmentModel();
      pasted.wbSource = 'Sampled';
      pasted.wbSampleX = 0.4;
      pasted.wbSampleY = 0.6;
      pasted.wbAlgorithmVersion = 0;
      const pastedXml = serializer.serialize(pasted);
      expect(pastedXml).toContain('papp:WbSource="Sampled"');
      expect(pastedXml).not.toContain('papp:WbSampleX');
      expect(pastedXml).not.toContain('papp:WbAlgorithmVersion');

      // A version left over on a model whose source is no longer derived
      // must not ride along either.
      const manual = defaultAdjustmentModel();
      manual.wbSource = 'Manual';
      manual.wbAlgorithmVersion = 1;
      expect(serializer.serialize(manual)).not.toContain('papp:WbAlgorithmVersion');
    });

    it('never writes the sample point without a sampled source (#3309)', () => {
      // A stale coordinate left in the model — a pasted look carries the
      // source but not the point — must not leak into the sidecar and claim
      // provenance the pair does not have. Matches raw-core and Swift.
      const m = defaultAdjustmentModel();
      m.wbSource = 'Preset';
      m.wbSampleX = 0.4;
      m.wbSampleY = 0.6;
      const xml = serializer.serialize(m);
      expect(xml).toContain('papp:WbSource="Preset"');
      expect(xml).not.toContain('papp:WbSampleX');
      expect(xml).not.toContain('papp:WbSampleY');
    });

    it('omits every provenance key at the default', () => {
      const xml = serializer.serialize(defaultAdjustmentModel());
      for (const key of [
        'papp:WbSource',
        'papp:WbSampleX',
        'papp:WbSampleY',
        'papp:WbAlgorithmVersion',
      ]) {
        expect(xml).not.toContain(key);
      }
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
