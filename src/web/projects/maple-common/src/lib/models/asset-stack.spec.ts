import { describe, it, expect } from 'vitest';
import {
  companionFilenameFor,
  idsWithCompanions,
  sameStack,
  stackFromWire,
  withStackCompanions,
} from './asset-stack';
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

describe('idsWithCompanions', () => {
  it('appends each stacked asset’s companion address to the selection', () => {
    expect(idsWithCompanions([raw.id, plain.id], [raw, plain])).toEqual([
      'lib:IMG_1.CR3',
      'lib:IMG_1.JPG',
      'lib:IMG_2.CR3',
    ]);
  });

  it('collapses a companion that is already in the selection', () => {
    expect(idsWithCompanions([raw.id, JPEG.id], [raw])).toEqual(['lib:IMG_1.CR3', 'lib:IMG_1.JPG']);
  });

  it('passes through ids that are not in the listing', () => {
    expect(idsWithCompanions(['lib:gone.CR3'], [raw])).toEqual(['lib:gone.CR3']);
  });
});

describe('withStackCompanions', () => {
  it('lists each file once, the RAW before its JPEG', () => {
    expect(withStackCompanions([raw, plain])).toEqual([
      { id: 'lib:IMG_1.CR3', filename: 'IMG_1.CR3' },
      { id: 'lib:IMG_1.JPG', filename: 'IMG_1.JPG' },
      { id: 'lib:IMG_2.CR3', filename: 'IMG_2.CR3' },
    ]);
  });
});

describe('companionFilenameFor', () => {
  it('keeps the companion’s own extension under the RAW’s new stem', () => {
    expect(companionFilenameFor('IMG_1.JPG', 'trip-001.CR3')).toBe('trip-001.JPG');
    expect(companionFilenameFor('IMG_1.jpeg', 'a.b.dng')).toBe('a.b.jpeg');
  });
});
