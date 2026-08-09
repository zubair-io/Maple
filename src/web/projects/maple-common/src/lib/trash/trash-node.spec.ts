import { describe, it, expect } from 'vitest';
import { libraryIdForRootNode, trashCountLabel } from './trash-node';
import type { ApiFolder } from '../workspace/server-library-io';

const FOLDER: ApiFolder = {
  id: 'lib-1',
  path: '/photos',
  slug: 'photos',
  label: 'Photos',
  last_scan: null,
  file_count: 0,
  created_at: '',
};

describe('libraryIdForRootNode', () => {
  it('resolves a library-root M2 address by slug', () => {
    expect(libraryIdForRootNode('photos:', [FOLDER])).toBe('lib-1');
  });

  it('falls back to matching by id when slug is absent', () => {
    const noSlug: ApiFolder = { ...FOLDER, slug: undefined };
    expect(libraryIdForRootNode('lib-1:', [noSlug])).toBe('lib-1');
  });

  it('returns null for a subfolder (non-root) address', () => {
    expect(libraryIdForRootNode('photos:Vacation', [FOLDER])).toBeNull();
  });

  it('returns null for legacy fs: ids', () => {
    expect(libraryIdForRootNode('fs:/photos', [FOLDER])).toBeNull();
  });

  it('returns null for smart/album ids with no colon', () => {
    expect(libraryIdForRootNode('smart:picks'.split(':')[0], [FOLDER])).toBeNull();
  });

  it('returns null when no registered library matches', () => {
    expect(libraryIdForRootNode('unknown:', [FOLDER])).toBeNull();
  });
});

describe('trashCountLabel', () => {
  it('renders no badge when the count is unknown', () => {
    expect(trashCountLabel(undefined)).toBeNull();
  });

  it('renders no badge when the library has zero trashed items', () => {
    expect(trashCountLabel({ count: 0, capped: false })).toBeNull();
  });

  it('renders the exact count when not capped', () => {
    expect(trashCountLabel({ count: 12, capped: false })).toBe('12');
  });

  it('renders a "+" suffix when the count page filled up', () => {
    expect(trashCountLabel({ count: 100, capped: true })).toBe('100+');
  });
});
