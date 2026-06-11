// brightness.spec.ts — XMP round-trip for the Brightness midtone slider (#1102).
//
// Mirrors the Swift tests in
// `src/apple/Packages/MapleCore/Tests/MapleCoreTests/XMPSerializationTests.swift`
// and the Rust tests in `raw-core/src/xmp/tests.rs` — Brightness serializes
// and parses the Maple-proprietary `papp:Brightness` key; the ACR PV2010
// `crs:Brightness` key (default +50, removed in PV2012, different semantics)
// is deliberately NOT parsed; and default-valued models emit no
// `papp:Brightness` so pre-#1102 sidecars stay byte-identical.

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

describe('XMP Brightness field (#1102)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it('parses `papp:Brightness` onto model.brightness', () => {
    const xml = makeSidecar(`papp:Brightness="-35"`);
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.brightness).toBe(-35);
  });

  it('does NOT parse the ACR PV2010 `crs:Brightness` key (different semantics)', () => {
    const xml = makeSidecar(`crs:Brightness="50"`);
    const { model } = parser.parseAdjustmentModel(xml);
    // Sparse parse result must not carry brightness at all from the legacy key.
    expect(model.brightness).toBeUndefined();
    const merged = { ...defaultAdjustmentModel(), ...model };
    expect(merged.brightness).toBe(0);
  });

  it('round-trips a non-default brightness through serialize → parse', () => {
    const m = defaultAdjustmentModel();
    m.brightness = 42;
    const xml = serializer.serialize(m);
    expect(xml).toContain('papp:Brightness="42"');
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.brightness).toBe(42);
  });

  it('omits `papp:Brightness` at the default (0) so pre-#1102 sidecars stay byte-identical', () => {
    const xml = serializer.serialize(defaultAdjustmentModel());
    expect(xml).not.toContain('papp:Brightness');
  });
});
