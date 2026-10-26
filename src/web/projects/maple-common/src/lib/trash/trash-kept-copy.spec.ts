import { describe, expect, it } from 'vitest';
import { folderAddressOf, keptCopiesNote } from './trash-kept-copy';
import type { ApiFolder } from '../workspace/server-library-io';

const folder = (id: string, slug: string, path: string): ApiFolder => ({
  id,
  slug,
  path,
  label: slug,
  last_scan: null,
  file_count: 0,
  created_at: '2026-01-01T00:00:00Z',
});

describe('folderAddressOf', () => {
  const folders = [
    folder('a', 'photos', '/vol/photos'),
    folder('b', 'archive', '/vol/photos-archive/'),
  ];

  it('resolves the folder holding the kept copy, in whichever library it is', () => {
    expect(folderAddressOf('/vol/photos/2024/Trip/IMG_1.dng', folders)).toBe('photos:2024/Trip');
    expect(folderAddressOf('/vol/photos-archive/IMG_1.dng', folders)).toBe('archive:');
  });

  it('is null when no registered library holds the path or the server sent none', () => {
    expect(folderAddressOf('/elsewhere/IMG_1.dng', folders)).toBeNull();
    expect(folderAddressOf(null, folders)).toBeNull();
  });
});

describe('keptCopiesNote', () => {
  it('is empty when nothing was kept', () => {
    expect(keptCopiesNote([], true)).toBe('');
  });
});
