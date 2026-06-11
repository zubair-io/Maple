// deep-denoise.spec.ts — XMP round-trip for BM3D deep denoise (#1105,
// tone/zoom design § 3.2).
//
// Mirrors the Swift tests in
// `src/apple/Packages/MapleCore/Tests/MapleCoreTests/XMPSerializationTests.swift`
// and the Rust tests in `raw-core/src/xmp/tests.rs` — `papp:DeepDenoise`
// serializes and parses as a Maple-proprietary numeric field, and
// default-valued models emit no attribute so pre-#1105 sidecars stay
// byte-identical.

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

describe('XMP DeepDenoise field (#1105)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it('parses `papp:DeepDenoise` onto model.deepDenoise', () => {
    const { model } = parser.parseAdjustmentModel(makeSidecar(`papp:DeepDenoise="70"`));
    expect(model.deepDenoise).toBe(70);
  });

  it('round-trips a non-default deepDenoise through serialize → parse', () => {
    const m = defaultAdjustmentModel();
    m.deepDenoise = 70;
    const xml = serializer.serialize(m);
    expect(xml).toContain('papp:DeepDenoise="70"');
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.deepDenoise).toBe(70);
  });

  it('omits `papp:DeepDenoise` at the default (0) so pre-#1105 sidecars stay byte-identical', () => {
    const xml = serializer.serialize(defaultAdjustmentModel());
    expect(xml).not.toContain('papp:DeepDenoise');
  });
});
