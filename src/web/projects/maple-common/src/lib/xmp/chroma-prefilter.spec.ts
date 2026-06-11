// chroma-prefilter.spec.ts — XMP round-trip for the decode-time chroma
// pre-filter (#1104, tone/zoom design § 3.1).
//
// Mirrors the Swift tests in
// `src/apple/Packages/MapleCore/Tests/MapleCoreTests/XMPSerializationTests.swift`
// and the Rust tests in `raw-core/src/xmp/tests.rs` — ChromaPrefilter
// serializes and parses the Maple-proprietary `papp:ChromaPrefilter` key
// (it is NOT ACR's `crs:ColorNoiseReduction`, which maps onto the
// late-chain `nrColor` NLM slider), and default-valued models emit no
// `papp:ChromaPrefilter` so pre-#1104 sidecars stay byte-identical.

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

describe('XMP ChromaPrefilter field (#1104)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it('parses `papp:ChromaPrefilter` onto model.chromaPrefilter', () => {
    const xml = makeSidecar(`papp:ChromaPrefilter="35"`);
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.chromaPrefilter).toBe(35);
    // The decode-product field must not leak onto the late-chain NLM slider.
    expect(model.nrColor).toBeUndefined();
  });

  it('round-trips a non-default chromaPrefilter through serialize → parse', () => {
    const m = defaultAdjustmentModel();
    m.chromaPrefilter = 35;
    const xml = serializer.serialize(m);
    expect(xml).toContain('papp:ChromaPrefilter="35"');
    const { model } = parser.parseAdjustmentModel(xml);
    expect(model.chromaPrefilter).toBe(35);
  });

  it('omits `papp:ChromaPrefilter` at the default (0) so pre-#1104 sidecars stay byte-identical', () => {
    const xml = serializer.serialize(defaultAdjustmentModel());
    expect(xml).not.toContain('papp:ChromaPrefilter');
  });
});
