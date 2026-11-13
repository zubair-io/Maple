import { describe, expect, it } from 'vitest';
import { cameraLocationRows } from './info-panel.vm';
import { HOSTED_INFO_EXIF_TAGS, hostedInfoFields } from './hosted-info-exif';
import type { Asset } from '../models/asset';

const base: Asset = {
  id: 'test.CR2',
  filename: 'test.CR2',
  folderId: 'hosted',
  rating: 0,
  flag: 'unflagged',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
};

describe('Hosted Preview Info EXIF', () => {
  it('shows the six camera fields from a RAW EXIF result', () => {
    const fields = hostedInfoFields({
      Make: 'Canon',
      Model: 'Canon EOS 5DS R',
      LensModel: 'EF50mm f/1.2L USM',
      FNumber: 5.6,
      ExposureTime: 0.004,
      ISO: 200,
      FocalLength: 50,
    });
    expect(
      Object.fromEntries(cameraLocationRows({ ...base, ...fields }).map((r) => [r.label, r.value])),
    ).toMatchObject({
      Body: 'Canon EOS 5DS R',
      Lens: 'EF50mm f/1.2L USM',
      Aperture: 'f/5.6',
      Shutter: '1/250',
      ISO: '200',
      Focal: '50mm',
    });
  });

  it('leaves genuinely missing or invalid fields as placeholders', () => {
    const fields = hostedInfoFields({ Model: '', FNumber: 0, ISO: Number.NaN });
    expect(cameraLocationRows({ ...base, ...fields }).map((r) => r.value)).toEqual(
      Array(8).fill('—'),
    );
  });

  it('uses standard APEX aperture metadata when FNumber is absent', () => {
    expect(hostedInfoFields({ ApertureValue: 2 * Math.log2(5.6) }).aperture).toBe('f/5.6');
    expect(hostedInfoFields({ ApertureValue: 0 }).aperture).toBe('f/1');
    expect(hostedInfoFields({ ApertureValue: 2 * Math.log2(0.95) }).aperture).toBe('f/0.95');
  });

  it('reads a Leica M10 FNumber only from a validated maker-note entry', () => {
    const note = new Uint8Array(26);
    note.set([0x4c, 0x45, 0x49, 0x43, 0x41, 0, 2, 0]);
    const view = new DataView(note.buffer);
    view.setUint16(8, 1, true);
    view.setUint16(10, 0x035a, true);
    view.setUint16(12, 9, true);
    view.setUint32(14, 1, true);
    view.setInt32(18, 5600, true);
    expect(hostedInfoFields({ makerNote: note }).aperture).toBe('f/5.6');
    expect(hostedInfoFields({ makerNote: note.subarray(0, 22) }).aperture).toBe('f/5.6');
    note[0] = 0;
    expect(hostedInfoFields({ makerNote: note }).aperture).toBeUndefined();
  });

  it('uses signed GPS shortcuts and retains hemisphere refs in the parser pick list', () => {
    expect(HOSTED_INFO_EXIF_TAGS).toContain('GPSLatitudeRef');
    expect(HOSTED_INFO_EXIF_TAGS).toContain('GPSLongitudeRef');
    expect(
      hostedInfoFields({
        GPSLatitude: [33, 51, 0],
        GPSLongitude: [118, 20, 0],
        latitude: -33.85,
        longitude: -118.33,
      }).gps,
    ).toEqual({ lat: -33.85, lon: -118.33 });
  });
});
