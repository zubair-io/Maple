import { describe, expect, it } from 'vitest';
import { cameraLocationRows } from './info-panel.vm';
import { hostedInfoFields } from './hosted-info-exif';
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
  });
});
