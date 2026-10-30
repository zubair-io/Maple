import { describe, expect, it } from 'bun:test';
import { pairLivePhotos } from './live-photo-pairs.ts';

const ID = '3F2A8C1E-9B47-4D55-A6E0-0C7D1B2E4F90';
const OTHER = '9A1B2C3D-0000-4D55-A6E0-0C7D1B2E4F91';
const asset = (filename: string, live_content_id: string | null) => ({ filename, live_content_id });

describe('pairLivePhotos', () => {
  it.each(['IMG_1234.HEIC', 'IMG_1234.JPG', 'IMG_1234.heif', 'IMG_1234.jpeg'])(
    'pairs %s with its clip when the identifiers match',
    (still) => {
      const pairs = pairLivePhotos([asset(still, ID), asset('IMG_1234.MOV', ID)]);
      expect(pairs.get(still)).toEqual({ role: 'still', partner: 'IMG_1234.MOV' });
      expect(pairs.get('IMG_1234.MOV')).toEqual({ role: 'clip', partner: still });
    },
  );

  it('keeps a same-stem still and clip independent when their identifiers differ', () => {
    const pairs = pairLivePhotos([asset('IMG_1234.HEIC', ID), asset('IMG_1234.MOV', OTHER)]);
    expect(pairs.size).toBe(0);
  });

  it('keeps them independent when either side has no identifier', () => {
    expect(pairLivePhotos([asset('IMG_1.HEIC', null), asset('IMG_1.MOV', ID)]).size).toBe(0);
    expect(pairLivePhotos([asset('IMG_1.HEIC', ID), asset('IMG_1.MOV', null)]).size).toBe(0);
    expect(pairLivePhotos([asset('IMG_1.HEIC', null), asset('IMG_1.MOV', null)]).size).toBe(0);
  });

  it('does not pair files whose stems differ even with equal identifiers', () => {
    const pairs = pairLivePhotos([asset('IMG_1234.HEIC', ID), asset('IMG_9999.MOV', ID)]);
    expect(pairs.size).toBe(0);
  });

  it('matches stems and identifiers regardless of case', () => {
    const pairs = pairLivePhotos([asset('img_1234.heic', ID), asset('IMG_1234.mov', ID)]);
    expect(pairs.get('img_1234.heic')?.partner).toBe('IMG_1234.mov');
  });

  it('pairs several Live Photos in one folder without crossing them', () => {
    const pairs = pairLivePhotos([
      asset('IMG_1.HEIC', ID),
      asset('IMG_1.MOV', ID),
      asset('IMG_2.HEIC', OTHER),
      asset('IMG_2.MOV', OTHER),
      asset('IMG_3.HEIC', null),
    ]);
    expect(pairs.get('IMG_1.HEIC')?.partner).toBe('IMG_1.MOV');
    expect(pairs.get('IMG_2.MOV')?.partner).toBe('IMG_2.HEIC');
    expect(pairs.has('IMG_3.HEIC')).toBe(false);
  });

  it('leaves an ambiguous group independent', () => {
    const pairs = pairLivePhotos([
      asset('IMG_1.HEIC', ID),
      asset('IMG_1.JPG', ID),
      asset('IMG_1.MOV', ID),
    ]);
    expect(pairs.size).toBe(0);
  });

  it('ignores files that cannot be a Live Photo half', () => {
    const pairs = pairLivePhotos([asset('IMG_1.DNG', ID), asset('IMG_1.MOV', ID)]);
    expect(pairs.size).toBe(0);
  });
});
