import { describe, it, expect } from 'vitest';
import { XmpSerializerService } from './xmp-serializer.service';
import { XmpParserService } from './xmp-parser.service';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { XmpMetadata } from './xmp.types';

const ser = new XmpSerializerService();
const parser = new XmpParserService();

describe('serialize with metadata', () => {
  it('declares only the used namespaces and emits attrs + nested in order', () => {
    const meta: XmpMetadata = {
      gpsLatitude: 48.8566,
      gpsLongitude: 2.3522,
      city: 'Paris',
      title: 'Sunset',
      creator: 'Ansel Adams',
      copyrightNotice: '© 2026 Z. Lawrence',
    };
    const xml = ser.serialize(defaultAdjustmentModel(), undefined, undefined, meta);

    // namespaces
    expect(xml).toContain('xmlns:exif="http://ns.adobe.com/exif/1.0/"');
    expect(xml).toContain('xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"');
    expect(xml).toContain('xmlns:dc="http://purl.org/dc/elements/1.1/"');
    expect(xml).not.toContain('xmlns:xmpRights'); // none used here

    // attributes
    expect(xml).toContain('exif:GPSLatitude="48,51.3960N"');
    expect(xml).toContain('photoshop:City="Paris"');

    // nested, in order: title before creator before rights
    const iTitle = xml.indexOf('<dc:title>');
    const iCreator = xml.indexOf('<dc:creator>');
    const iRights = xml.indexOf('<dc:rights>');
    expect(iTitle).toBeGreaterThan(-1);
    expect(iCreator).toBeGreaterThan(iTitle);
    expect(iRights).toBeGreaterThan(iCreator);
  });

  it('emits no metadata namespaces or fields when metadata is omitted', () => {
    const xml = ser.serialize(defaultAdjustmentModel());
    expect(xml).not.toContain('xmlns:exif');
    expect(xml).not.toContain('exif:GPSLatitude');
  });

  it('coexists with keyword dc:subject (single dc namespace decl)', () => {
    const xml = ser.serialize(
      defaultAdjustmentModel(),
      undefined,
      { keywords: ['travel'] },
      {
        title: 'T',
      },
    );
    expect(xml).toContain('<dc:subject>');
    expect(xml).toContain('<dc:title>');
    // dc namespace declared exactly once
    expect(xml.match(/xmlns:dc=/g)?.length).toBe(1);
  });
});

describe('parseMetadata round-trip', () => {
  const full: XmpMetadata = {
    gpsLatitude: 48.8566,
    gpsLongitude: 2.3522,
    gpsAltitude: 35,
    dateTimeOriginal: '2026-06-26T18:40:00+02:00',
    timeZone: 'Europe/Paris',
    sublocation: 'Rue Vignon',
    city: 'Paris',
    state: 'Île-de-France',
    country: 'France',
    countryCode: 'FR',
    title: 'Sunset',
    caption: 'Notes here & <there>',
    headline: 'Trip',
    instructions: 'Embargo until July',
    creator: 'Ansel Adams',
    creatorJobTitle: 'Photographer',
    copyrightNotice: '© 2026 Z. Lawrence',
    copyrightStatus: 'copyrighted',
    usageTerms: 'All rights reserved',
    credit: 'Z. Lawrence',
    source: 'Maple',
  };

  it('round-trips every field serialize -> parse', () => {
    const xml = ser.serialize(defaultAdjustmentModel(), undefined, undefined, full);
    const parsed = parser.parseMetadata(xml);
    expect(parsed.gpsLatitude).toBeCloseTo(48.8566, 4);
    expect(parsed.gpsLongitude).toBeCloseTo(2.3522, 4);
    expect(parsed.gpsAltitude).toBeCloseTo(35, 2);
    expect(parsed.dateTimeOriginal).toBe('2026-06-26T18:40:00+02:00');
    expect(parsed.timeZone).toBe('Europe/Paris');
    expect(parsed.sublocation).toBe('Rue Vignon');
    expect(parsed.city).toBe('Paris');
    expect(parsed.state).toBe('Île-de-France');
    expect(parsed.country).toBe('France');
    expect(parsed.countryCode).toBe('FR');
    expect(parsed.title).toBe('Sunset');
    expect(parsed.caption).toBe('Notes here & <there>');
    expect(parsed.headline).toBe('Trip');
    expect(parsed.instructions).toBe('Embargo until July');
    expect(parsed.creator).toBe('Ansel Adams');
    expect(parsed.creatorJobTitle).toBe('Photographer');
    expect(parsed.copyrightNotice).toBe('© 2026 Z. Lawrence');
    expect(parsed.copyrightStatus).toBe('copyrighted');
    expect(parsed.usageTerms).toBe('All rights reserved');
    expect(parsed.credit).toBe('Z. Lawrence');
    expect(parsed.source).toBe('Maple');
  });

  it('is byte-stable: serialize -> parse -> serialize is identical', () => {
    const xml1 = ser.serialize(defaultAdjustmentModel(), undefined, { keywords: ['travel'] }, full);
    const meta2 = parser.parseMetadata(xml1);
    const culling2 = parser.parseCulling(xml1);
    const { passthrough } = parser.parseAdjustmentModel(xml1);
    const xml2 = ser.serialize(
      defaultAdjustmentModel(),
      passthrough,
      { keywords: culling2.keywords },
      meta2,
    );
    expect(xml2).toBe(xml1);
  });

  it('does NOT double-emit managed nested elements via passthrough', () => {
    const xml1 = ser.serialize(defaultAdjustmentModel(), undefined, undefined, {
      title: 'T',
      creator: 'C',
      caption: 'D',
      copyrightNotice: 'R',
      usageTerms: 'U',
    });
    const { passthrough } = parser.parseAdjustmentModel(xml1);
    // None of the managed nested elements leak into passthrough nodes.
    const joined = passthrough.unknownNodes.join('');
    for (const tag of [
      'dc:title',
      'dc:creator',
      'dc:description',
      'dc:rights',
      'xmpRights:UsageTerms',
    ]) {
      expect(joined).not.toContain(tag);
    }
    // None of the managed attributes leak into passthrough attributes.
    const names = passthrough.unknownAttributes.map((a) => a.name);
    for (const key of ['exif:GPSLatitude', 'photoshop:City', 'xmpRights:Marked', 'papp:TimeZone']) {
      expect(names).not.toContain(key);
    }
  });

  it('leaves a genuinely-unknown node in passthrough untouched', () => {
    const src = ser.serialize(defaultAdjustmentModel(), {
      unknownAttributes: [],
      unknownNodes: [
        '<crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li></rdf:Seq></crs:ToneCurvePV2012>',
      ],
    });
    const { passthrough } = parser.parseAdjustmentModel(src);
    expect(passthrough.unknownNodes.join('')).toContain('crs:ToneCurvePV2012');
  });
});
