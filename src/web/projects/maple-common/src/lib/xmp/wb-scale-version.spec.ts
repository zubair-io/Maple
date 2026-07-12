// wb-scale-version.spec.ts — XMP round-trip for the WB slider-scale
// version stamp (#1780/#1875/#1893/#1894).
//
// Mirrors the Swift tests in
// `src/apple/Packages/MapleCore/Tests/MapleCoreTests/WbScaleVersionTests.swift`
// and the Rust tests in `raw-core/src/xmp/tests_wb_scale.rs`:
//
//  - explicit `papp:WbScaleVersion` stamp wins;
//  - Maple-authored sidecar (papp namespace present) with no stamp is
//    version 1 (pre-#1756 scale);
//  - non-Maple sidecar (no papp namespace — ACR/Lightroom-authored) is
//    version 5 (the Robertson mapping, #1894 — ACR's own convention);
//  - a V2/V3/V4 stamp load-normalizes: the authored `(temperature, tint)`
//    pair converts JOINTLY through `authoredPairToV5` (physical
//    chromaticity, not a scalar tint multiply) and the model becomes 5;
//  - the serializer stamps the model's version ({1, 5}) whenever it
//    writes an explicit Temperature/Tint, and omits the stamp otherwise.
//
// Expected converted values below are cross-checked against the golden
// vectors generated from the Rust `authored_pair_to_v5` reference (see
// `wb-dng-temperature.spec.ts`) at the same tolerance (0.05 K / 0.005 tint).

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { defaultAdjustmentModel } from '../models/adjustment-model';

function mapleSidecar(attrs: string): string {
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

/** ACR-shaped sidecar: `crs:` only, no Maple namespace anywhere. */
function acrSidecar(attrs: string): string {
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    ${attrs}>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

describe('XMP WbScaleVersion (#1780)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it('reads a Maple-authored sidecar without a stamp as version 1', () => {
    const xml = mapleSidecar(`crs:Temperature="6282" crs:Tint="-44"`);
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.wbScaleVersion).toBe(1);
    expect(model.temperature).toBe(6282);
    expect(model.tint).toBe(-44);
  });

  it('reads an ACR-authored sidecar (no papp namespace) as version 5', () => {
    // ACR's crs:Temperature/crs:Tint are already expressed in the
    // Robertson (V5, #1894) convention — pass through unconverted.
    const xml = acrSidecar(`crs:Temperature="5500" crs:Tint="10"`);
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.wbScaleVersion).toBe(5);
    expect(model.temperature).toBe(5500);
    expect(model.tint).toBe(10);
  });

  it('honours an explicit stamp over the authorship heuristic', () => {
    // A V2 stamp beats the V1 heuristic, then load-normalizes to 5. No
    // tint was authored (absent-tint convention: 0), but the pair
    // conversion is JOINT (#1894) — an authored temperature alone still
    // moves both components, so `tint` is no longer undefined afterward.
    const xml = mapleSidecar(`crs:Temperature="5700" papp:WbScaleVersion="2"`);
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.wbScaleVersion).toBe(5);
    expect(model.temperature).toBeCloseTo(5697.0, 1);
    expect(model.tint).toBeCloseTo(11.08, 2);
  });

  it('leaves a WB-less V2/V3/V4-stamped sidecar untouched — no manufactured WB (#1901 review)', () => {
    // The conversion gates on the ATTRIBUTE-PRESENCE record
    // (`canonicallyApplied`, the analogue of Swift's `sawExplicitWb` and
    // raw-core's seen-flags), not on model-field definedness. A stamped
    // sidecar authoring no crs:Temperature/crs:Tint must parse with both
    // components still undefined — running the pair conversion on the
    // defaults would manufacture a WB adjustment out of nothing (the two
    // loci differ even at 6500/0) and bake it in on the next save.
    for (const stamp of ['2', '3', '4']) {
      const xml = mapleSidecar(`crs:Exposure2012="0.5" papp:WbScaleVersion="${stamp}"`);
      const { model } = parser.parseAdjustmentModel(xml);
      expect(model.temperature, `stamp ${stamp}`).toBeUndefined();
      expect(model.tint, `stamp ${stamp}`).toBeUndefined();
      expect(model.wbScaleVersion).toBe(5);
    }
  });

  it('converts a V2-authored pair jointly into V5 on load (#1875/#1893/#1894)', () => {
    // The V2 scale's tint axis was inverted vs ACR at the legacy 1e-4
    // magnitude, evaluated on the Hernández-Andrés locus. Both temperature
    // and tint move when re-expressed in the V5 (Robertson) coordinates of
    // the same physical chromaticity.
    const xml = mapleSidecar(`crs:Temperature="5700" crs:Tint="50" papp:WbScaleVersion="2"`);
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.wbScaleVersion).toBe(5);
    expect(model.temperature).toBeCloseTo(5696.39, 1);
    expect(model.tint).toBeCloseTo(-3.92, 2);
  });

  it('converts a V3-authored pair jointly into V5 on load (#1893/#1894)', () => {
    // V3 is the ACR direction at the legacy 1e-4 magnitude, legacy locus.
    const xml = mapleSidecar(`crs:Temperature="5520" crs:Tint="-144" papp:WbScaleVersion="3"`);
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.wbScaleVersion).toBe(5);
    expect(model.temperature).toBeCloseTo(5526.09, 1);
    expect(model.tint).toBeCloseTo(-32.58, 2);
  });

  it('converts a V4-authored pair jointly into V5 on load (#1894)', () => {
    // V4 shares V5's tint magnitude/axis but evaluated on the legacy
    // (Hernández-Andrés) locus rather than Robertson — never shipped in a
    // release, but a dev-window sidecar must still load-normalize.
    const xml = mapleSidecar(`crs:Temperature="5520" crs:Tint="-53" papp:WbScaleVersion="4"`);
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.wbScaleVersion).toBe(5);
    expect(model.temperature).toBeCloseTo(5526.6, 1);
    expect(model.tint).toBeCloseTo(-42.38, 2);
  });

  it('passes a V5-stamped pair through unconverted', () => {
    const xml = mapleSidecar(`crs:Temperature="5520" crs:Tint="-53" papp:WbScaleVersion="5"`);
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.wbScaleVersion).toBe(5);
    expect(model.temperature).toBe(5520);
    expect(model.tint).toBe(-53);
  });

  it('keeps the stamp out of the passthrough bucket', () => {
    const xml = mapleSidecar(`crs:Temperature="5700" papp:WbScaleVersion="2"`);
    const { passthrough } = parser.parseAdjustmentModel(xml);
    expect(passthrough.unknownAttributes.some((a) => a.name === 'papp:WbScaleVersion')).toBe(false);
  });

  it('defaults a fresh model to version 5', () => {
    expect(defaultAdjustmentModel().wbScaleVersion).toBe(5);
  });

  it('stamps version 5 when a fresh model writes an explicit temperature', () => {
    // 'Custom' marks the pair as authored — an As-Shot model's values are
    // the camera display seed and are omitted entirely (#1892).
    const m = {
      ...defaultAdjustmentModel(),
      temperature: 5200,
      whiteBalancePreset: 'Custom' as const,
    };
    const xml = serializer.serialize(m);
    expect(xml).toContain('papp:WbScaleVersion="5"');
  });

  it('stamps version 5 for a tint-only explicit WB', () => {
    const m = { ...defaultAdjustmentModel(), tint: -30, whiteBalancePreset: 'Custom' as const };
    const xml = serializer.serialize(m);
    expect(xml).toContain('papp:WbScaleVersion="5"');
  });

  it('omits the stamp when temperature and tint are at defaults', () => {
    const m = { ...defaultAdjustmentModel(), exposure: 0.5 };
    const xml = serializer.serialize(m);
    expect(xml).not.toContain('papp:WbScaleVersion');
  });

  it('round-trips a V1 sidecar as V1 — a re-save must not silently upgrade the scale', () => {
    // Load a pre-#1756 Maple sidecar (no stamp → version 1), re-serialize,
    // and parse the output again: the values must still be tagged V1 so
    // raw-core keeps converting them. Upgrading without converting the
    // numbers would reintroduce exactly the #1780 pink cast.
    const original = mapleSidecar(`crs:Temperature="6282" crs:Tint="-44"`);
    const { model: parsed, passthrough } = parser.parseAdjustmentModel(original);
    const merged = { ...defaultAdjustmentModel(), ...parsed };
    const reserialized = serializer.serialize(merged, passthrough);
    expect(reserialized).toContain('papp:WbScaleVersion="1"');
    const { model: reparsed } = parser.parseAdjustmentModel(reserialized);
    expect(reparsed.wbScaleVersion).toBe(1);
    expect(reparsed.temperature).toBe(6282);
    expect(reparsed.tint).toBe(-44);
  });

  it('detects the papp namespace on an OUTER element, not just rdf:Description', () => {
    // raw-core and the Swift parser record `xmlns:papp`/`papp:` from ANY
    // element; a writer that declares the namespace on `x:xmpmeta` is
    // still Maple-authored and its unstamped explicit WB must read as V1.
    const xml = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:papp="http://ns.justmaple.app/photo/1.0/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    crs:Temperature="6282" crs:Tint="-44">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.wbScaleVersion).toBe(1);
  });

  it('clamps an out-of-range wbScaleVersion to 5 at write time', () => {
    // raw-core's parser hard-fails on an unknown stamp — a corrupted model
    // field must never produce an unparseable sidecar.
    const m = {
      ...defaultAdjustmentModel(),
      temperature: 5500,
      wbScaleVersion: 7,
      whiteBalancePreset: 'Custom' as const,
    };
    const xml = serializer.serialize(m);
    expect(xml).toContain('papp:WbScaleVersion="5"');
  });
});
