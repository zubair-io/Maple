import { describe, it, expect } from 'vitest';
import { companionFilenameFor, freePairFilename } from './stack-pair-names';

describe('companionFilenameFor', () => {
  it('keeps the companion’s own extension under the RAW’s new stem', () => {
    expect(companionFilenameFor('IMG_1.JPG', 'trip-001.CR3')).toBe('trip-001.JPG');
    expect(companionFilenameFor('IMG_1.jpeg', 'a.b.dng')).toBe('a.b.jpeg');
  });
});

describe('freePairFilename', () => {
  const names = (...list: string[]) => new Set(list.map((name) => name.toLowerCase()));

  it('skips a suffix that is free for the RAW but taken for the JPEG', () => {
    expect(
      freePairFilename(names('IMG_1.CR3', 'IMG_1.JPG', 'IMG_1.1.jpg'), 'IMG_1.CR3', 'IMG_1.JPG'),
    ).toBe('IMG_1.2.CR3');
  });

  it('skips a suffix whose shared sidecar is taken', () => {
    expect(freePairFilename(names('IMG_1.1.xmp'), 'IMG_1.CR3', 'IMG_1.JPG')).toBe('IMG_1.2.CR3');
  });

  it('uses the server’s `.N` shape from the first suffix', () => {
    expect(freePairFilename(names('IMG_1.CR3'), 'IMG_1.CR3', 'IMG_1.JPG')).toBe('IMG_1.1.CR3');
  });
});
