/**
 * Unit tests for the server-side XMP metadata parser.
 *
 * Uses real XMP snippets that mirror what the web serializer produces,
 * so a change to the serializer format is visible here.
 */

import { describe, test, expect } from 'bun:test';
import { parseXmpMetadata, xmpMetadataToOverridePatch } from './metadata-parser.ts';

// ---------------------------------------------------------------------------
// Helper: build a minimal XMP sidecar string with given content
// ---------------------------------------------------------------------------
function makeXmp(descAttrs: string, nestedContent = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:exif="http://ns.adobe.com/exif/1.0/"
   xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
   xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"
   xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:papp="https://justmaple.app/ns/1.0/"
   ${descAttrs}>
${nestedContent}  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
}

// ---------------------------------------------------------------------------
// GPS
// ---------------------------------------------------------------------------

describe('parseXmpMetadata — GPS', () => {
  test('parses latitude and longitude', () => {
    const xml = makeXmp('exif:GPSLatitude="48,31.4360N" exif:GPSLongitude="2,21.0480E"');
    const result = parseXmpMetadata(xml);
    // 48° + 31.4360/60 min ≈ 48.5240°
    expect(result.gpsLatitude).toBeCloseTo(48.524, 3);
    expect(result.gpsLongitude).toBeCloseTo(2.351, 2);
  });

  test('parses south/west hemisphere as negative', () => {
    const xml = makeXmp('exif:GPSLatitude="33,51.5208S" exif:GPSLongitude="151,12.3600W"');
    const result = parseXmpMetadata(xml);
    expect(result.gpsLatitude).toBeLessThan(0);
    expect(result.gpsLongitude).toBeLessThan(0);
  });

  test('parses altitude (above sea level)', () => {
    const xml = makeXmp('exif:GPSAltitude="35000/1000" exif:GPSAltitudeRef="0"');
    const result = parseXmpMetadata(xml);
    expect(result.gpsAltitude).toBeCloseTo(35, 2);
  });

  test('parses altitude below sea level', () => {
    const xml = makeXmp('exif:GPSAltitude="400000/1000" exif:GPSAltitudeRef="1"');
    const result = parseXmpMetadata(xml);
    expect(result.gpsAltitude).toBeCloseTo(-400, 2);
  });

  test('returns no GPS fields when absent', () => {
    const xml = makeXmp('photoshop:City="Paris"');
    const result = parseXmpMetadata(xml);
    expect(result.gpsLatitude).toBeUndefined();
    expect(result.gpsLongitude).toBeUndefined();
    expect(result.gpsAltitude).toBeUndefined();
  });

  test('ignores malformed GPS strings', () => {
    const xml = makeXmp('exif:GPSLatitude="not-a-coord"');
    const result = parseXmpMetadata(xml);
    expect(result.gpsLatitude).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Date/time and timezone
// ---------------------------------------------------------------------------

describe('parseXmpMetadata — date/time', () => {
  test('parses DateTimeOriginal', () => {
    const xml = makeXmp('exif:DateTimeOriginal="2026-06-26T18:40:00+02:00"');
    expect(parseXmpMetadata(xml).dateTimeOriginal).toBe('2026-06-26T18:40:00+02:00');
  });

  test('parses papp:TimeZone', () => {
    const xml = makeXmp('papp:TimeZone="Europe/Paris"');
    expect(parseXmpMetadata(xml).timeZone).toBe('Europe/Paris');
  });

  test('absent fields return undefined', () => {
    const xml = makeXmp('photoshop:City="Paris"');
    expect(parseXmpMetadata(xml).dateTimeOriginal).toBeUndefined();
    expect(parseXmpMetadata(xml).timeZone).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// IPTC text attrs (simple string attributes)
// ---------------------------------------------------------------------------

describe('parseXmpMetadata — IPTC text attrs', () => {
  test('parses all place text attrs', () => {
    const xml = makeXmp(
      'Iptc4xmpCore:Location="Eiffel Tower" photoshop:City="Paris" photoshop:State="Île-de-France" photoshop:Country="France" Iptc4xmpCore:CountryCode="FR"',
    );
    const r = parseXmpMetadata(xml);
    expect(r.sublocation).toBe('Eiffel Tower');
    expect(r.city).toBe('Paris');
    expect(r.state).toBe('Île-de-France');
    expect(r.country).toBe('France');
    expect(r.countryCode).toBe('FR');
  });

  test('parses headline and instructions', () => {
    const xml = makeXmp('photoshop:Headline="Breaking News" photoshop:Instructions="Do not crop"');
    const r = parseXmpMetadata(xml);
    expect(r.headline).toBe('Breaking News');
    expect(r.instructions).toBe('Do not crop');
  });

  test('parses creator metadata attrs', () => {
    const xml = makeXmp(
      'photoshop:AuthorsPosition="Staff Photographer" photoshop:Credit="AP" photoshop:Source="Reuters"',
    );
    const r = parseXmpMetadata(xml);
    expect(r.creatorJobTitle).toBe('Staff Photographer');
    expect(r.credit).toBe('AP');
    expect(r.source).toBe('Reuters');
  });

  test('whitespace-only value returns undefined', () => {
    const xml = makeXmp('photoshop:City="   "');
    expect(parseXmpMetadata(xml).city).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Copyright status
// ---------------------------------------------------------------------------

describe('parseXmpMetadata — copyrightStatus', () => {
  test('True → copyrighted', () => {
    const xml = makeXmp('xmpRights:Marked="True"');
    expect(parseXmpMetadata(xml).copyrightStatus).toBe('copyrighted');
  });

  test('False → public-domain', () => {
    const xml = makeXmp('xmpRights:Marked="False"');
    expect(parseXmpMetadata(xml).copyrightStatus).toBe('public-domain');
  });

  test('absent → undefined', () => {
    const xml = makeXmp('photoshop:City="Paris"');
    expect(parseXmpMetadata(xml).copyrightStatus).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Nested lang-alt / seq elements
// ---------------------------------------------------------------------------

describe('parseXmpMetadata — nested elements', () => {
  test('parses dc:title lang-alt block', () => {
    const xml = makeXmp(
      '',
      `  <dc:title>
   <rdf:Alt>
    <rdf:li xml:lang="x-default">My Title</rdf:li>
   </rdf:Alt>
  </dc:title>`,
    );
    expect(parseXmpMetadata(xml).title).toBe('My Title');
  });

  test('parses dc:creator seq block', () => {
    const xml = makeXmp(
      '',
      `  <dc:creator>
   <rdf:Seq>
    <rdf:li>Zubair Lawrence</rdf:li>
   </rdf:Seq>
  </dc:creator>`,
    );
    expect(parseXmpMetadata(xml).creator).toBe('Zubair Lawrence');
  });

  test('parses dc:description lang-alt (caption)', () => {
    const xml = makeXmp(
      '',
      `  <dc:description>
   <rdf:Alt>
    <rdf:li xml:lang="x-default">A lovely photo</rdf:li>
   </rdf:Alt>
  </dc:description>`,
    );
    expect(parseXmpMetadata(xml).caption).toBe('A lovely photo');
  });

  test('parses dc:rights lang-alt (copyright notice)', () => {
    const xml = makeXmp(
      '',
      `  <dc:rights>
   <rdf:Alt>
    <rdf:li xml:lang="x-default">© 2026 Z. Lawrence</rdf:li>
   </rdf:Alt>
  </dc:rights>`,
    );
    expect(parseXmpMetadata(xml).copyrightNotice).toBe('© 2026 Z. Lawrence');
  });

  test('parses xmpRights:UsageTerms lang-alt', () => {
    const xml = makeXmp(
      '',
      `  <xmpRights:UsageTerms>
   <rdf:Alt>
    <rdf:li xml:lang="x-default">All rights reserved</rdf:li>
   </rdf:Alt>
  </xmpRights:UsageTerms>`,
    );
    expect(parseXmpMetadata(xml).usageTerms).toBe('All rights reserved');
  });

  test('absent nested elements return undefined', () => {
    const xml = makeXmp('photoshop:City="Paris"');
    const r = parseXmpMetadata(xml);
    expect(r.title).toBeUndefined();
    expect(r.creator).toBeUndefined();
    expect(r.caption).toBeUndefined();
    expect(r.copyrightNotice).toBeUndefined();
    expect(r.usageTerms).toBeUndefined();
  });

  test('XML entity escaping is decoded', () => {
    const xml = makeXmp(
      '',
      `  <dc:title>
   <rdf:Alt>
    <rdf:li xml:lang="x-default">R&amp;D &lt;Notes&gt;</rdf:li>
   </rdf:Alt>
  </dc:title>`,
    );
    expect(parseXmpMetadata(xml).title).toBe('R&D <Notes>');
  });
});

// ---------------------------------------------------------------------------
// Keywords (dc:subject bag)
// ---------------------------------------------------------------------------

describe('parseXmpMetadata — keywords', () => {
  test('parses dc:subject bag', () => {
    const xml = makeXmp(
      '',
      `  <dc:subject>
   <rdf:Bag>
    <rdf:li>travel</rdf:li>
    <rdf:li>france</rdf:li>
    <rdf:li>paris</rdf:li>
   </rdf:Bag>
  </dc:subject>`,
    );
    expect(parseXmpMetadata(xml).keywords).toEqual(['travel', 'france', 'paris']);
  });

  test('deduplicates keywords', () => {
    const xml = makeXmp(
      '',
      `  <dc:subject>
   <rdf:Bag>
    <rdf:li>travel</rdf:li>
    <rdf:li>travel</rdf:li>
    <rdf:li>france</rdf:li>
   </rdf:Bag>
  </dc:subject>`,
    );
    expect(parseXmpMetadata(xml).keywords).toEqual(['travel', 'france']);
  });

  test('absent dc:subject returns undefined keywords', () => {
    const xml = makeXmp('photoshop:City="Paris"');
    expect(parseXmpMetadata(xml).keywords).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('parseXmpMetadata — edge cases', () => {
  test('empty string returns empty object', () => {
    expect(parseXmpMetadata('')).toEqual({});
  });

  test('malformed XML returns empty object', () => {
    expect(parseXmpMetadata('<broken>')).toEqual({});
  });

  test('XMP with no metadata fields returns empty object', () => {
    const xml = makeXmp('crs:Exposure="0.5" crs:Contrast="0.0"');
    const r = parseXmpMetadata(xml);
    // Adjustment fields should not appear in the result.
    expect(r.dateTimeOriginal).toBeUndefined();
    expect(r.city).toBeUndefined();
    expect(r.title).toBeUndefined();
  });

  test('result has no undefined keys', () => {
    const xml = makeXmp('photoshop:City="Paris"');
    const r = parseXmpMetadata(xml);
    for (const [, v] of Object.entries(r)) {
      expect(v).not.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// xmpMetadataToOverridePatch
// ---------------------------------------------------------------------------

describe('xmpMetadataToOverridePatch', () => {
  test('maps GPS to {lat, lng, alt}', () => {
    const patch = xmpMetadataToOverridePatch({
      gpsLatitude: 48.8566,
      gpsLongitude: 2.3522,
      gpsAltitude: 35,
    });
    expect(patch.gps).toEqual({ lat: 48.8566, lng: 2.3522, alt: 35 });
  });

  test('omits alt when not present', () => {
    const patch = xmpMetadataToOverridePatch({ gpsLatitude: 48.8566, gpsLongitude: 2.3522 });
    expect(patch.gps).toEqual({ lat: 48.8566, lng: 2.3522 });
    expect((patch.gps as { alt?: number } | undefined)?.alt).toBeUndefined();
  });

  test('does not set gps when only lat is present', () => {
    const patch = xmpMetadataToOverridePatch({ gpsLatitude: 48.8566 });
    expect(patch.gps).toBeUndefined();
  });

  test('maps place text fields', () => {
    const patch = xmpMetadataToOverridePatch({
      city: 'Paris',
      country: 'France',
      countryCode: 'FR',
    });
    expect(patch.place_text).toEqual({ city: 'Paris', country: 'France', country_code: 'FR' });
  });

  test('maps copyright_status', () => {
    const patch = xmpMetadataToOverridePatch({ copyrightStatus: 'copyrighted' });
    expect(patch.copyright_status).toBe('copyrighted');
  });

  test('empty result returns empty patch', () => {
    expect(xmpMetadataToOverridePatch({})).toEqual({});
  });
});
