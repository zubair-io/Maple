// wb-scale-version.spec.ts — XMP round-trip for the WB slider-scale
// version stamp (#1780).
//
// Mirrors the Swift tests in
// `src/apple/Packages/MapleCore/Tests/MapleCoreTests/XMPSerializationTests.swift`
// and the Rust tests in `raw-core/src/xmp/tests_wb_scale.rs`:
//
//  - explicit `papp:WbScaleVersion` stamp wins;
//  - Maple-authored sidecar (papp namespace present) with no stamp is
//    version 1 (pre-#1756 scale);
//  - non-Maple sidecar (no papp namespace — ACR/Lightroom-authored) is
//    version 2 (ACR's own scale, which #1756 adopted);
//  - the serializer stamps the model's version whenever it writes an
//    explicit Temperature/Tint, and omits the stamp otherwise.

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

  it('reads an ACR-authored sidecar (no papp namespace) as version 2', () => {
    const xml = acrSidecar(`crs:Temperature="5500" crs:Tint="10"`);
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.wbScaleVersion).toBe(2);
  });

  it('honours an explicit stamp over the authorship heuristic', () => {
    const xml = mapleSidecar(`crs:Temperature="5700" papp:WbScaleVersion="2"`);
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.wbScaleVersion).toBe(2);
  });

  it('keeps the stamp out of the passthrough bucket', () => {
    const xml = mapleSidecar(`crs:Temperature="5700" papp:WbScaleVersion="2"`);
    const { passthrough } = parser.parseAdjustmentModel(xml);
    expect(passthrough.unknownAttributes.some((a) => a.name === 'papp:WbScaleVersion')).toBe(false);
  });

  it('defaults a fresh model to version 2', () => {
    expect(defaultAdjustmentModel().wbScaleVersion).toBe(2);
  });

  it('stamps version 2 when a fresh model writes an explicit temperature', () => {
    const m = { ...defaultAdjustmentModel(), temperature: 5200 };
    const xml = serializer.serialize(m);
    expect(xml).toContain('papp:WbScaleVersion="2"');
  });

  it('stamps version 2 for a tint-only explicit WB', () => {
    const m = { ...defaultAdjustmentModel(), tint: -30 };
    const xml = serializer.serialize(m);
    expect(xml).toContain('papp:WbScaleVersion="2"');
  });

  it('omits the stamp when temperature and tint are at defaults', () => {
    const m = { ...defaultAdjustmentModel(), exposure: 0.5 };
    const xml = serializer.serialize(m);
    expect(xml).not.toContain('papp:WbScaleVersion');
  });

  it('round-trips a V1 sidecar as V1 — a re-save must not silently upgrade the scale', () => {
    // Load a pre-#1756 Maple sidecar (no stamp → version 1), re-serialize,
    // and parse the output again: the values must still be tagged V1 so
    // raw-core keeps converting them. Upgrading to 2 without converting
    // the numbers would reintroduce exactly the #1780 pink cast.
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
});
