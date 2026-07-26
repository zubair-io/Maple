// xmp-canonical.spec.ts — the TypeScript half of the cross-engine
// byte-canonical contract (#1577).
//
// `CANONICAL_GOLDEN_DOCUMENT` below is the same literal as
// `xmpCanonicalGoldenDocument` in
// `src/apple/Packages/MapleCore/Tests/MapleCoreTests/XMPCanonicalFormatTests.swift`,
// and `canonicalFixtureModel` builds the same model as that file's
// `canonicalFixtureModel`. Both suites assert their own serializer reproduces
// the literal, so a divergence on either platform fails that platform's tests
// — the zero-byte-diff check without a build that runs Swift and TypeScript in
// one process.
//
// What the parity claim covers, precisely: the canonical document for a model
// both writers emit the same field set for. It is not whole-document equality
// for arbitrary round-tripped sidecars — this writer preserves unknown
// attributes and nested nodes while Apple's has no passthrough at all (#2233),
// so a document carrying foreign fields cannot be byte-equal across the two.
// It also excludes `papp:Hidden` (no web writer), `papp:WbMethod` /
// `papp:ToneCurveMode` (no Apple model field — #2216) and default-valued
// sliders (Apple authors them unconditionally, this writer omits them); the
// fixture therefore sets every unconditionally-emitted field to a non-default
// value.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { sortCanonicalAttributes } from './xmp-canonical';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { AdjustmentModel } from '../models/adjustment-model';

/** See the file header — mirrored by `canonicalFixtureModel()` in Swift. */
function canonicalFixtureModel(): AdjustmentModel {
  return {
    ...defaultAdjustmentModel(),
    whiteBalancePreset: 'Custom',
    temperature: 5200,
    tint: -14.5,
    wbScaleVersion: 5,
    exposure: 0.5,
    brightness: 6,
    contrast: 12,
    highlights: -30,
    shadows: 25,
    whites: 8,
    blacks: -6,
    parametricHighlights: 4,
    parametricLights: -3,
    parametricDarks: 2.5,
    parametricShadows: -1,
    vibrance: 15,
    saturation: -10,
    clarity: 20,
    texture: 7,
    dehaze: 5,
    sharpenAmount: 55,
    sharpenRadius: 1.4,
    sharpenDetail: 30,
    sharpenMasking: 12,
    captureSharpeningAmount: 35,
    captureSharpeningSigma: 0.8,
    nrLuminance: 18,
    nrColor: 30,
    chromaPrefilter: 3,
    deepDenoise: 9,
    vignetteAmount: -20,
    vignetteFeather: 40,
    grainAmount: 10,
    grainSize: 30,
    grainRoughness: 45,
    splitToneShadowHue: 210,
    splitToneShadowSaturation: 12,
    splitToneHighlightHue: 45,
    splitToneHighlightSaturation: 8,
    splitToneBalance: -5,
    colorGradeShadowLuminance: 3,
    colorGradeMidtoneHue: 120,
    colorGradeMidtoneSaturation: 14,
    colorGradeMidtoneLuminance: -2,
    colorGradeHighlightLuminance: 6,
    colorGradeGlobalHue: 300,
    colorGradeGlobalSaturation: 9,
    colorGradeGlobalLuminance: 1,
    hueAdjustmentRed: 5,
    hueAdjustmentAqua: -7,
    saturationAdjustmentGreen: 11,
    luminanceAdjustmentBlue: -13,
    blackWhite: 'On',
    grayMixerRed: 22,
    grayMixerMagenta: -18,
    highlightRecovery: 'Blend',
    autoExposure: 'Off',
    hotPixelSuppression: 'On',
    profile: 'Neutral',
    crop: { top: 0.1, left: 0.05, bottom: 0.9, right: 0.95, angle: 2.5 },
    toneCurveLuma: {
      points: [
        [0, 0],
        [0.5, 0.55],
        [1, 1],
      ],
    },
    toneCurveBlue: {
      points: [
        [0, 0],
        [1, 0.8],
      ],
    },
  };
}

/** Mirrored by `canonicalFixtureCulling()` in Swift. */
const canonicalFixtureCulling = {
  rating: 4,
  flag: 'pick',
  colorLabel: 'green',
  keywords: ['alpha', 'bravo & co'],
};

describe('canonical XMP document (#1577)', () => {
  let serializer: XmpSerializerService;
  let parser: XmpParserService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    serializer = TestBed.inject(XmpSerializerService);
    parser = TestBed.inject(XmpParserService);
  });

  it('serializes the shared fixture to the cross-engine golden, byte for byte', () => {
    const produced = serializer.serialize(
      canonicalFixtureModel(),
      undefined,
      canonicalFixtureCulling,
    );
    expect(produced).toBe(CANONICAL_GOLDEN_DOCUMENT);
  });

  // The four divergences #1577 was filed for, asserted directly so a
  // regression names itself rather than showing up as an opaque string diff.
  it('binds papp: to the canonical URI and declares namespaces in order', () => {
    const doc = serializer.serialize(canonicalFixtureModel(), undefined, canonicalFixtureCulling);
    expect(doc).toContain('      xmlns:papp="http://ns.justmaple.app/photo/1.0/"');
    const positions = ['xmlns:xmp=', 'xmlns:crs=', 'xmlns:papp=', 'xmlns:dc='].map((n) =>
      doc.indexOf(n),
    );
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(doc).not.toContain('x:xmptk');
  });

  it('sorts attributes by namespace priority then alphabetically', () => {
    const doc = serializer.serialize(canonicalFixtureModel(), undefined, canonicalFixtureCulling);
    const order = ['xmp:Rating=', 'crs:Blacks2012=', 'crs:Whites2012=', 'papp:Brightness='].map(
      (n) => doc.indexOf(n),
    );
    expect(order.every((p) => p >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('sorts unknown namespaces after every known one', () => {
    expect(
      sortCanonicalAttributes([
        'zz:Foo="1"',
        'papp:Flag="pick"',
        'crs:Exposure2012="0.5"',
        'xmp:Rating="4"',
        'aa:Bar="2"',
      ]),
    ).toEqual([
      'xmp:Rating="4"',
      'crs:Exposure2012="0.5"',
      'papp:Flag="pick"',
      'aa:Bar="2"',
      'zz:Foo="1"',
    ]);
  });

  it('puts every nested child on one six-space indent ladder', () => {
    const doc = serializer.serialize(canonicalFixtureModel(), undefined, canonicalFixtureCulling);
    for (const line of [
      '      <dc:subject>',
      '        <rdf:Bag>',
      '          <rdf:li>alpha</rdf:li>',
      '      <papp:SceneLinearToneCurve>',
      '        <rdf:Seq>',
    ]) {
      expect(doc).toContain(line);
    }
  });

  // A sidecar in the pre-#1577 Apple layout — the old `papp:` URI, the old
  // `crs, xmp, papp` declaration order, no `rdf:about`, unsorted attributes.
  // Every parser keys on the `papp:` prefix rather than the URI it is bound
  // to, so files already on disk keep loading; they upgrade on the next save.
  it('still parses a sidecar written in the pre-canonical layout', () => {
    const { model } = parser.parseAdjustmentModel(LEGACY_LAYOUT_SIDECAR);
    const culling = parser.parseCulling(LEGACY_LAYOUT_SIDECAR);
    expect(model.temperature).toBe(5200);
    expect(model.tint).toBe(-14.5);
    expect(model.wbScaleVersion).toBe(5);
    expect(model.exposure).toBe(0.5);
    expect(model.contrast).toBe(12);
    expect(model.shadows).toBe(25);
    expect(model.sharpenRadius).toBe(1.4);
    expect(model.captureSharpeningSigma).toBe(0.8);
    expect(model.profile).toBe('Neutral');
    expect(culling.rating).toBe(4);
    expect(culling.flag).toBe('pick');
    expect(culling.colorLabel).toBe('green');
    expect(culling.keywords).toEqual(['alpha']);
    expect(model.toneCurveLuma?.points.length).toBe(2);
    expect(model.toneCurveLuma?.points[1][0]).toBeCloseTo(0.5, 6);
    expect(model.toneCurveLuma?.points[1][1]).toBeCloseTo(0.55, 6);
  });

  it('is a fixed point of write → parse → write', () => {
    const original = serializer.serialize(
      canonicalFixtureModel(),
      undefined,
      canonicalFixtureCulling,
    );
    const { model, passthrough } = parser.parseAdjustmentModel(original);
    const culling = parser.parseCulling(original);
    const resaved = serializer.serialize(
      { ...defaultAdjustmentModel(), ...model },
      passthrough,
      culling,
    );
    expect(resaved).toBe(original);
  });
});

/**
 * A pre-canonical sidecar, kept verbatim so the re-save path is pinned against
 * real legacy bytes. The `begin` attribute's U+FEFF is written as an explicit
 * escape, not a literal: this fixture is compared byte-for-byte, so an
 * invisible character here would let an editor silently move the goalposts.
 */
const LEGACY_LAYOUT_SIDECAR = [
  '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
  '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
  '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
  '    <rdf:Description',
  '      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
  '      xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
  '      xmlns:papp="http://ns.justmaple.app/1.0/"',
  '      xmlns:dc="http://purl.org/dc/elements/1.1/"',
  '      crs:Temperature="5200"',
  '      crs:Tint="-14.5"',
  '      papp:WbScaleVersion="5"',
  '      crs:Exposure2012="0.50"',
  '      crs:Contrast2012="12"',
  '      crs:Shadows2012="25"',
  '      crs:SharpenRadius="1.4"',
  '      papp:CaptureSharpeningSigma="0.8"',
  '      papp:Profile="Neutral"',
  '      papp:Flag="pick"',
  '      papp:ColorLabel="green"',
  '      xmp:Rating="4">',
  '      <dc:subject>',
  '        <rdf:Bag>',
  '          <rdf:li>alpha</rdf:li>',
  '        </rdf:Bag>',
  '      </dc:subject>',
  '      <papp:SceneLinearToneCurve>',
  '        <rdf:Seq>',
  '          <rdf:li>0, 0</rdf:li>',
  '          <rdf:li>127.5, 140.25</rdf:li>',
  '        </rdf:Seq>',
  '      </papp:SceneLinearToneCurve>',
  '    </rdf:Description>',
  '  </rdf:RDF>',
  '</x:xmpmeta>',
  '<?xpacket end="w"?>',
].join('\n');

/**
 * See the file header: this literal is duplicated verbatim in
 * `XMPCanonicalFormatTests.swift`. Any canonical-format change updates both
 * copies and `docs/xmp-canonical-format.md` in the same commit.
 */
const CANONICAL_GOLDEN_DOCUMENT = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/photo/1.0/"
      xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmp:Rating="4"
      crs:Blacks2012="-6"
      crs:Clarity2012="20"
      crs:ColorGradeGlobalHue="300"
      crs:ColorGradeGlobalLum="1"
      crs:ColorGradeGlobalSat="9"
      crs:ColorGradeHighlightLum="6"
      crs:ColorGradeMidtoneHue="120"
      crs:ColorGradeMidtoneLum="-2"
      crs:ColorGradeMidtoneSat="14"
      crs:ColorGradeShadowLum="3"
      crs:ColorNoiseReduction="30"
      crs:Contrast2012="12"
      crs:ConvertToGrayscale="True"
      crs:CropAngle="2.500000"
      crs:CropBottom="0.900000"
      crs:CropConstrainToWarp="0"
      crs:CropLeft="0.050000"
      crs:CropRight="0.950000"
      crs:CropTop="0.100000"
      crs:Dehaze="5"
      crs:Exposure2012="0.5"
      crs:GrainAmount="10"
      crs:GrainFrequency="45"
      crs:GrainSize="30"
      crs:GrayMixerMagenta="-18"
      crs:GrayMixerRed="22"
      crs:HasCrop="True"
      crs:HasSettings="True"
      crs:Highlights2012="-30"
      crs:HueAdjustmentAqua="-7"
      crs:HueAdjustmentRed="5"
      crs:LuminanceAdjustmentBlue="-13"
      crs:LuminanceSmoothing="18"
      crs:ParametricDarks="2.5"
      crs:ParametricHighlights="4"
      crs:ParametricLights="-3"
      crs:ParametricShadows="-1"
      crs:PostCropVignetteAmount="-20"
      crs:PostCropVignetteFeather="40"
      crs:ProcessVersion="11.0"
      crs:Saturation="-10"
      crs:SaturationAdjustmentGreen="11"
      crs:Shadows2012="25"
      crs:SharpenDetail="30"
      crs:SharpenEdgeMasking="12"
      crs:SharpenRadius="1.4"
      crs:Sharpness="55"
      crs:SplitToningBalance="-5"
      crs:SplitToningHighlightHue="45"
      crs:SplitToningHighlightSaturation="8"
      crs:SplitToningShadowHue="210"
      crs:SplitToningShadowSaturation="12"
      crs:Temperature="5200"
      crs:Texture="7"
      crs:Tint="-14.5"
      crs:Version="11.0"
      crs:Vibrance="15"
      crs:WhiteBalance="Custom"
      crs:Whites2012="8"
      papp:AutoExposure="Off"
      papp:Brightness="6"
      papp:CaptureSharpeningAmount="35"
      papp:CaptureSharpeningSigma="0.8"
      papp:ChromaPrefilter="3"
      papp:ColorLabel="green"
      papp:DeepDenoise="9"
      papp:Flag="pick"
      papp:HighlightRecoveryMode="Blend"
      papp:HotPixelSuppression="On"
      papp:Profile="Neutral"
      papp:WbScaleVersion="5">
      <dc:subject>
        <rdf:Bag>
          <rdf:li>alpha</rdf:li>
          <rdf:li>bravo &amp; co</rdf:li>
        </rdf:Bag>
      </dc:subject>
      <papp:SceneLinearToneCurve>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>127.5, 140.25</rdf:li>
          <rdf:li>255, 255</rdf:li>
        </rdf:Seq>
      </papp:SceneLinearToneCurve>
      <papp:SceneLinearToneCurveBlue>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>255, 204</rdf:li>
        </rdf:Seq>
      </papp:SceneLinearToneCurveBlue>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
