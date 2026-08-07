import { describe, it, expect } from 'vitest';

import { splitFilenameExt } from './filename-ext';

describe('splitFilenameExt', () => {
  it('splits a normal filename into stem + extension (dot included)', () => {
    expect(splitFilenameExt('IMG_0001.CR3')).toEqual({ stem: 'IMG_0001', ext: '.CR3' });
  });

  it('treats a name with no dot as having no extension', () => {
    expect(splitFilenameExt('IMG_0001')).toEqual({ stem: 'IMG_0001', ext: '' });
  });

  it('treats a leading-dot hidden-file-style name with no other dot as having no extension', () => {
    expect(splitFilenameExt('.gitignore')).toEqual({ stem: '.gitignore', ext: '' });
  });

  it('uses the LAST dot for a multi-dot filename', () => {
    expect(splitFilenameExt('vacation.2024.dng')).toEqual({
      stem: 'vacation.2024',
      ext: '.dng',
    });
  });

  it('handles a bare extension change target consistently', () => {
    const { stem, ext } = splitFilenameExt('photo.jpg');
    expect(stem).toBe('photo');
    expect(ext).toBe('.jpg');
  });
});
