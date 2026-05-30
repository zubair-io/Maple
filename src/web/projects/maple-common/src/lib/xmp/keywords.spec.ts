// keywords.spec.ts — XMP `dc:subject` round-trip (#632). Mirrors the
// Apple parity tests in
// `src/apple/Packages/MapleCore/Tests/MapleCoreTests/AdjustmentModelTests.swift`:
//
//   • write an asset with N keywords, parse it back, the list is identical;
//   • empty list omits the `<dc:subject>` element entirely;
//   • XML-special characters in keyword text escape/de-escape cleanly;
//   • `dc:subject` does not get double-emitted through `passthrough.unknownNodes`.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { XmpCulling } from './xmp.types';

function defaultCulling(): XmpCulling {
  return { rating: 0, flag: 'unflagged', colorLabel: null, keywords: [] };
}

describe('XMP dc:subject keyword round-trip (#632)', () => {
  let parser: XmpParserService;
  let serializer: XmpSerializerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    parser = TestBed.inject(XmpParserService);
    serializer = TestBed.inject(XmpSerializerService);
  });

  it('omits dc:subject and the dc namespace when keywords are empty', () => {
    const xml = serializer.serialize(defaultAdjustmentModel(), undefined, defaultCulling());
    expect(xml).not.toContain('dc:subject');
    expect(xml).not.toContain('xmlns:dc=');
  });

  it('emits dc:subject + rdf:Bag + rdf:li for each keyword in source order', () => {
    const culling: XmpCulling = {
      ...defaultCulling(),
      keywords: ['travel', 'paris', '2026', 'golden hour'],
    };
    const xml = serializer.serialize(defaultAdjustmentModel(), undefined, culling);
    expect(xml).toContain('xmlns:dc="http://purl.org/dc/elements/1.1/"');
    expect(xml).toContain('<dc:subject>');
    expect(xml).toContain('<rdf:Bag>');
    expect(xml).toContain('<rdf:li>travel</rdf:li>');
    expect(xml).toContain('<rdf:li>paris</rdf:li>');
    expect(xml).toContain('<rdf:li>2026</rdf:li>');
    expect(xml).toContain('<rdf:li>golden hour</rdf:li>');
    // Source order survives — `golden hour` appears after `paris`.
    expect(xml.indexOf('paris')).toBeLessThan(xml.indexOf('golden hour'));
  });

  it('round-trips a keyword list through parseCulling', () => {
    const culling: XmpCulling = {
      ...defaultCulling(),
      keywords: ['travel', 'paris', '2026', 'golden hour'],
    };
    const xml = serializer.serialize(defaultAdjustmentModel(), undefined, culling);
    const parsed = parser.parseCulling(xml);
    expect(parsed.keywords).toEqual(['travel', 'paris', '2026', 'golden hour']);
  });

  it('round-trips a single keyword (no off-by-one on the bag)', () => {
    const culling: XmpCulling = { ...defaultCulling(), keywords: ['solo'] };
    const xml = serializer.serialize(defaultAdjustmentModel(), undefined, culling);
    expect(parser.parseCulling(xml).keywords).toEqual(['solo']);
  });

  it('escapes XML special characters on the write path and decodes on read', () => {
    const culling: XmpCulling = {
      ...defaultCulling(),
      keywords: ['fish & chips', '<tag>', '5 > 3'],
    };
    const xml = serializer.serialize(defaultAdjustmentModel(), undefined, culling);
    expect(xml).toContain('fish &amp; chips');
    expect(xml).toContain('&lt;tag&gt;');
    expect(parser.parseCulling(xml).keywords).toEqual(['fish & chips', '<tag>', '5 > 3']);
  });

  it('returns an empty keyword list when the sidecar has no dc:subject', () => {
    const xml = serializer.serialize(defaultAdjustmentModel(), undefined, defaultCulling());
    expect(parser.parseCulling(xml).keywords).toEqual([]);
  });

  it('drops blank rdf:li entries on the read path', () => {
    const xml = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:subject>
    <rdf:Bag>
     <rdf:li>real</rdf:li>
     <rdf:li>   </rdf:li>
     <rdf:li></rdf:li>
     <rdf:li>also real</rdf:li>
    </rdf:Bag>
   </dc:subject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
    expect(parser.parseCulling(xml).keywords).toEqual(['real', 'also real']);
  });

  it('does not surface dc:subject in passthrough.unknownNodes', () => {
    // A sidecar whose source carries dc:subject — the parser hands the
    // keywords back via parseCulling, NOT via the passthrough bucket.
    // If passthrough collected it, the serializer would re-emit it
    // alongside the canonical dc:subject block, producing two copies.
    const xml = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:subject>
    <rdf:Bag>
     <rdf:li>kw</rdf:li>
    </rdf:Bag>
   </dc:subject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
    const { passthrough } = parser.parseAdjustmentModel(xml);
    const surfaced = passthrough.unknownNodes.some((n) => n.includes('dc:subject'));
    expect(surfaced).toBe(false);
  });

  it('emits exactly one dc:subject element on re-serialize from a parsed sidecar', () => {
    // Critical regression guard for the double-emit hazard: even if the
    // source XMP already had dc:subject, the serializer must produce
    // exactly one — the canonical block from `culling.keywords` — not
    // re-emit it through the passthrough bucket too.
    const source = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    crs:Exposure2012="1.0">
   <dc:subject>
    <rdf:Bag>
     <rdf:li>kw</rdf:li>
    </rdf:Bag>
   </dc:subject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
    const { passthrough } = parser.parseAdjustmentModel(source);
    const culling = parser.parseCulling(source);
    const xml = serializer.serialize(defaultAdjustmentModel(), passthrough, culling);
    const count = (xml.match(/<dc:subject>/g) ?? []).length;
    expect(count).toBe(1);
  });
});
