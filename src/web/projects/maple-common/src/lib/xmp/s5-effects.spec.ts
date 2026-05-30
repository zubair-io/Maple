// s5-effects.spec.ts — XMP round-trip for the S5 effects fields (#643).
//
// Mirrors the Swift tests in
// `src/apple/Packages/MapleCore/Tests/MapleCoreTests/AdjustmentModelTests.swift`
// — vignette / grain / split-tone serialize and parse Lightroom-compatible
// `crs:` keys, and default-valued models emit no `crs:` keys so pre-#643
// sidecars stay byte-identical.

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

describe('XMP S5 effects fields (#643)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it('parses Lightroom-compatible `crs:` keys for vignette / grain / split-tone', () => {
    const xml = makeSidecar(
      `crs:PostCropVignetteAmount="-40"
       crs:PostCropVignetteFeather="70"
       crs:GrainAmount="35"
       crs:GrainSize="40"
       crs:GrainFrequency="55"
       crs:SplitToningShadowHue="220"
       crs:SplitToningShadowSaturation="30"
       crs:SplitToningHighlightHue="40"
       crs:SplitToningHighlightSaturation="25"
       crs:SplitToningBalance="-15"`,
    );
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.vignetteAmount).toBe(-40);
    expect(model.vignetteFeather).toBe(70);
    expect(model.grainAmount).toBe(35);
    expect(model.grainSize).toBe(40);
    // Lightroom: "GrainFrequency"; Maple: `grainRoughness` (S5 § 3.13).
    expect(model.grainRoughness).toBe(55);
    expect(model.splitToneShadowHue).toBe(220);
    expect(model.splitToneShadowSaturation).toBe(30);
    expect(model.splitToneHighlightHue).toBe(40);
    expect(model.splitToneHighlightSaturation).toBe(25);
    expect(model.splitToneBalance).toBe(-15);
  });

  it('round-trips non-default S5 effects values via serialize → parse', () => {
    const model = defaultAdjustmentModel();
    model.vignetteAmount = -35;
    model.vignetteFeather = 80;
    model.grainAmount = 25;
    model.grainSize = 40;
    model.grainRoughness = 60;
    model.splitToneShadowHue = 200;
    model.splitToneShadowSaturation = 20;
    model.splitToneHighlightHue = 45;
    model.splitToneHighlightSaturation = 15;
    model.splitToneBalance = -10;

    const xml = serializer.serialize(model);
    expect(xml).toContain('crs:PostCropVignetteAmount="-35"');
    expect(xml).toContain('crs:GrainFrequency="60"');
    expect(xml).toContain('crs:SplitToningBalance="-10"');

    const { model: parsed } = parser.parseAdjustmentModel(xml);
    expect(parsed.vignetteAmount).toBe(-35);
    expect(parsed.vignetteFeather).toBe(80);
    expect(parsed.grainAmount).toBe(25);
    expect(parsed.grainSize).toBe(40);
    expect(parsed.grainRoughness).toBe(60);
    expect(parsed.splitToneShadowHue).toBe(200);
    expect(parsed.splitToneShadowSaturation).toBe(20);
    expect(parsed.splitToneHighlightHue).toBe(45);
    expect(parsed.splitToneHighlightSaturation).toBe(15);
    expect(parsed.splitToneBalance).toBe(-10);
  });

  it('does NOT emit any S5 `crs:` keys for a default model', () => {
    // Pre-#643 sidecars stay byte-identical for users who never touch
    // the new tools — the serializer omits attributes equal to the
    // canonical default.
    const xml = serializer.serialize(defaultAdjustmentModel());
    expect(xml).not.toContain('crs:PostCropVignetteAmount');
    expect(xml).not.toContain('crs:PostCropVignetteFeather');
    expect(xml).not.toContain('crs:GrainAmount');
    expect(xml).not.toContain('crs:GrainSize');
    expect(xml).not.toContain('crs:GrainFrequency');
    expect(xml).not.toContain('crs:SplitToningShadowHue');
    expect(xml).not.toContain('crs:SplitToningShadowSaturation');
    expect(xml).not.toContain('crs:SplitToningHighlightHue');
    expect(xml).not.toContain('crs:SplitToningHighlightSaturation');
    expect(xml).not.toContain('crs:SplitToningBalance');
  });
});
