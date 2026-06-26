import { describe, it, expect } from 'vitest';
import {
  gpsToXmp,
  gpsFromXmp,
  altitudeToXmp,
  altitudeFromXmp,
  langAltBlock,
  seqBlock,
  escapeXmlText,
  metadataAttrParts,
} from './xmp-metadata';
import type { XmpMetadata } from './xmp.types';

describe('gpsToXmp', () => {
  it('encodes a northern latitude as deg,decimal-min with N', () => {
    expect(gpsToXmp(48.8566, 'lat')).toBe('48,51.3960N');
  });
  it('encodes a southern latitude with S and positive minutes', () => {
    expect(gpsToXmp(-33.8688, 'lat')).toBe('33,52.1280S');
  });
  it('encodes a western longitude with W', () => {
    expect(gpsToXmp(-73.9857, 'lon')).toBe('73,59.1420W');
  });
  it('encodes an eastern longitude with E', () => {
    expect(gpsToXmp(2.3522, 'lon')).toBe('2,21.1320E');
  });
});

describe('gpsFromXmp', () => {
  it('decodes N latitude back to signed decimal', () => {
    expect(gpsFromXmp('48,51.3960N')).toBeCloseTo(48.8566, 4);
  });
  it('decodes S latitude as negative', () => {
    expect(gpsFromXmp('33,52.1280S')).toBeCloseTo(-33.8688, 4);
  });
  it('decodes W longitude as negative', () => {
    expect(gpsFromXmp('73,59.1420W')).toBeCloseTo(-73.9857, 4);
  });
  it('returns null for malformed input', () => {
    expect(gpsFromXmp('not-a-coord')).toBeNull();
  });
});

describe('altitudeToXmp', () => {
  it('encodes a positive altitude as a /1000 rational, ref 0', () => {
    expect(altitudeToXmp(35)).toEqual({ value: '35000/1000', ref: '0' });
  });
  it('encodes a below-sea-level altitude with ref 1 and positive magnitude', () => {
    expect(altitudeToXmp(-12.5)).toEqual({ value: '12500/1000', ref: '1' });
  });
});

describe('altitudeFromXmp', () => {
  it('decodes a /1000 rational with ref 0 to positive meters', () => {
    expect(altitudeFromXmp('35000/1000', '0')).toBeCloseTo(35, 3);
  });
  it('decodes ref 1 to negative meters', () => {
    expect(altitudeFromXmp('12500/1000', '1')).toBeCloseTo(-12.5, 3);
  });
  it('returns null for a malformed rational', () => {
    expect(altitudeFromXmp('abc', '0')).toBeNull();
  });
});

describe('langAltBlock', () => {
  it('emits an x-default rdf:Alt block with 2-space indentation', () => {
    expect(langAltBlock('dc:title', 'Sunset')).toBe(
      [
        '  <dc:title>',
        '   <rdf:Alt>',
        '    <rdf:li xml:lang="x-default">Sunset</rdf:li>',
        '   </rdf:Alt>',
        '  </dc:title>',
      ].join('\n'),
    );
  });
  it('escapes XML text content', () => {
    expect(langAltBlock('dc:rights', '© A & B <x>')).toContain(
      '<rdf:li xml:lang="x-default">© A &amp; B &lt;x&gt;</rdf:li>',
    );
  });
});

describe('seqBlock', () => {
  it('emits an rdf:Seq with one rdf:li', () => {
    expect(seqBlock('dc:creator', 'Ansel Adams')).toBe(
      [
        '  <dc:creator>',
        '   <rdf:Seq>',
        '    <rdf:li>Ansel Adams</rdf:li>',
        '   </rdf:Seq>',
        '  </dc:creator>',
      ].join('\n'),
    );
  });
});

describe('escapeXmlText', () => {
  it('escapes &, <, >', () => {
    expect(escapeXmlText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });
});

describe('metadataAttrParts', () => {
  it('emits GPS, datetime, place, headline, and rights-marked attributes in order', () => {
    const m: XmpMetadata = {
      gpsLatitude: 48.8566,
      gpsLongitude: 2.3522,
      gpsAltitude: 35,
      dateTimeOriginal: '2026-06-26T18:40:00+02:00',
      timeZone: 'Europe/Paris',
      city: 'Paris',
      country: 'France',
      countryCode: 'FR',
      headline: 'Trip',
      copyrightStatus: 'copyrighted',
    };
    expect(metadataAttrParts(m)).toEqual([
      'exif:GPSLatitude="48,51.3960N"',
      'exif:GPSLongitude="2,21.1320E"',
      'exif:GPSAltitude="35000/1000"',
      'exif:GPSAltitudeRef="0"',
      'exif:DateTimeOriginal="2026-06-26T18:40:00+02:00"',
      'papp:TimeZone="Europe/Paris"',
      'photoshop:City="Paris"',
      'photoshop:Country="France"',
      'Iptc4xmpCore:CountryCode="FR"',
      'photoshop:Headline="Trip"',
      'xmpRights:Marked="True"',
    ]);
  });
  it('omits everything for an empty metadata object', () => {
    expect(metadataAttrParts({})).toEqual([]);
  });
  it('emits public-domain as Marked=False', () => {
    expect(metadataAttrParts({ copyrightStatus: 'public-domain' })).toEqual([
      'xmpRights:Marked="False"',
    ]);
  });
  it('omits Marked when status is unknown', () => {
    expect(metadataAttrParts({ copyrightStatus: 'unknown' })).toEqual([]);
  });
  it('escapes attribute values', () => {
    expect(metadataAttrParts({ city: 'A "B" & C' })).toEqual([
      'photoshop:City="A &quot;B&quot; &amp; C"',
    ]);
  });
});
