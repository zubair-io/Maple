import { describe, it, expect } from 'vitest';
import { XmpSerializerService } from './xmp-serializer.service';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { XmpMetadata } from './xmp.types';

const ser = new XmpSerializerService();

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
