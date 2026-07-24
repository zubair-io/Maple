// parametric-tone-curve.spec.ts — XMP round-trip for the PV2012 parametric
// tone-curve region sliders (#365).
//
// Mirrors the Swift tests in
// `src/apple/Packages/MapleCore/Tests/MapleCoreTests/XMPSerializationTests.swift`
// and the Rust tests in `raw-core/src/xmp/tests_effects.rs` — the four
// `parametric*` model scalars serialize to the Lightroom-compatible
// `crs:Parametric{Highlights,Lights,Darks,Shadows}` keys, parse back, and
// default-valued (0) models emit no `crs:Parametric*` at all so sidecars
// written before the tone-curve widget existed stay byte-identical.

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

describe('XMP parametric tone-curve fields (#365)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it('parses the four `crs:Parametric*` keys onto the model', () => {
    const xml = makeSidecar(
      `crs:ParametricHighlights="100"
       crs:ParametricLights="-50"
       crs:ParametricDarks="25"
       crs:ParametricShadows="-100"`,
    );
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.parametricHighlights).toBe(100);
    expect(model.parametricLights).toBe(-50);
    expect(model.parametricDarks).toBe(25);
    expect(model.parametricShadows).toBe(-100);
  });

  it('round-trips non-default parametric values through serialize → parse', () => {
    const m = defaultAdjustmentModel();
    m.parametricHighlights = 100;
    m.parametricLights = -50;
    m.parametricDarks = 25;
    m.parametricShadows = -100;
    const xml = serializer.serialize(m);
    expect(xml).toContain('crs:ParametricHighlights="100"');
    expect(xml).toContain('crs:ParametricLights="-50"');
    expect(xml).toContain('crs:ParametricDarks="25"');
    expect(xml).toContain('crs:ParametricShadows="-100"');
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.parametricHighlights).toBe(100);
    expect(model.parametricLights).toBe(-50);
    expect(model.parametricDarks).toBe(25);
    expect(model.parametricShadows).toBe(-100);
  });

  it('round-trips fractional drag values (widget writes are not integer-quantized)', () => {
    const m = defaultAdjustmentModel();
    m.parametricDarks = 12.75;
    const xml = serializer.serialize(m);
    expect(xml).toContain('crs:ParametricDarks="12.75"');
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.parametricDarks).toBe(12.75);
  });

  it('omits all `crs:Parametric*` keys at the default (0) so untouched sidecars stay byte-identical', () => {
    const xml = serializer.serialize(defaultAdjustmentModel());
    expect(xml).not.toContain('crs:Parametric');
  });

  it('omits values that round to 0 in the wire codec instead of emitting `="0"`', () => {
    // PR #2192 review: the omit gate must operate on the serialized wire
    // form, not the raw value — 0.004 rounds to "0", which is the default.
    const m = defaultAdjustmentModel();
    m.parametricLights = 0.004;
    const xml = serializer.serialize(m);
    expect(xml).not.toContain('crs:Parametric');
  });
});
