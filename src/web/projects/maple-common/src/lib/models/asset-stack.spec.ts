import { describe, it, expect } from 'vitest';
import { sameStack, stackFromSearchWire, stackFromWire, stackTiles } from './asset-stack';
import type { Asset } from './asset';

const JPEG = { id: 'lib:IMG_1.JPG', name: 'IMG_1.JPG', ext: 'jpg', size: 4 };

const raw: Pick<Asset, 'id' | 'filename' | 'stack'> = {
  id: 'lib:IMG_1.CR3',
  filename: 'IMG_1.CR3',
  stack: { companion: JPEG },
};
const plain: Pick<Asset, 'id' | 'filename' | 'stack'> = {
  id: 'lib:IMG_2.CR3',
  filename: 'IMG_2.CR3',
};

describe('stackFromSearchWire (#5849)', () => {
  const companion = {
    id: 'jpeg-asset-id',
    name: 'IMG_1.JPG',
    path: '/lib/IMG_1.JPG',
    size: 4,
    mtime: '2026-01-01T00:00:00.000Z',
    ext: 'jpg',
  };

  it('keys a search hit’s companion by its address, as the listing does', () => {
    expect(stackFromSearchWire({ companion: { ...companion, address: 'lib:IMG_1.JPG' } })).toEqual({
      stack: { companion: JPEG },
    });
  });

  it('drops a companion with no address, which no file action could reach', () => {
    expect(stackFromSearchWire({ companion: { ...companion, address: null } })).toEqual({});
    expect(stackFromSearchWire(undefined)).toEqual({});
  });
});

describe('stackFromWire', () => {
  it('maps the listing companion address to an asset id', () => {
    expect(
      stackFromWire({
        companion: { name: 'IMG_1.JPG', address: 'lib:IMG_1.JPG', size: 4, ext: 'jpg' },
      }),
    ).toEqual({ stack: { companion: JPEG } });
  });

  it('yields nothing for an unstacked entry', () => {
    expect(stackFromWire(undefined)).toEqual({});
  });
});

describe('sameStack', () => {
  it('compares the companion identity, name and size', () => {
    expect(sameStack({ companion: JPEG }, { companion: { ...JPEG } })).toBe(true);
    expect(sameStack({ companion: JPEG }, undefined)).toBe(false);
    expect(sameStack(undefined, undefined)).toBe(true);
    expect(sameStack({ companion: JPEG }, { companion: { ...JPEG, size: 5 } })).toBe(false);
    expect(sameStack({ companion: JPEG }, { companion: { ...JPEG, id: 'lib:x/IMG_1.JPG' } })).toBe(
      false,
    );
  });
});

describe('stackTiles', () => {
  it('carries each stacked asset’s JPEG on its tile, one tile per selected asset', () => {
    expect(stackTiles([raw.id, plain.id], [raw, plain])).toEqual([
      {
        id: 'lib:IMG_1.CR3',
        filename: 'IMG_1.CR3',
        companion: { id: 'lib:IMG_1.JPG', filename: 'IMG_1.JPG' },
      },
      { id: 'lib:IMG_2.CR3', filename: 'IMG_2.CR3' },
    ]);
  });

  it('drops a selected id that is already another tile’s companion', () => {
    expect(stackTiles([raw.id, JPEG.id], [raw]).map((tile) => tile.id)).toEqual(['lib:IMG_1.CR3']);
  });

  it('keeps an id that is not in the listing as a one-file tile', () => {
    expect(stackTiles(['lib:gone.CR3'], [raw])).toEqual([
      { id: 'lib:gone.CR3', filename: 'lib:gone.CR3' },
    ]);
  });
});
