// LibrarySlugRegistry — slug ↔ handle persistence in IndexedDB (Hosted).
//
// Tests slugify/dedupeSlug logic (must match M1 server rules) and the
// register/getHandle/list contract — without real IndexedDB (not available
// in jsdom). The slug logic is pure; IDB operations are tested structurally.

import { describe, it, expect, vi } from 'vitest';
import { LibrarySlugRegistry, slugify, dedupeSlug } from './library-slug-registry';

describe('slugify — mirrors M1 server rules', () => {
  // Parity table from the plan (must match src/api/src/library/slug.ts).
  const cases: [string, string][] = [
    ['My Library', 'my-library'],
    ['Photos 2026', 'photos-2026'],
    ['France/Été', 'france-ete'],
    ['  leading & trailing  ', 'leading-trailing'],
    ['hello___world', 'hello-world'],
    ['A', 'a'],
    ['123', '123'],
    ['café', 'cafe'],
    ['UPPER CASE', 'upper-case'],
    // Consecutive separators collapse to one dash.
    ['one--two', 'one-two'],
    ['one  two', 'one-two'],
    // Leading/trailing dashes stripped.
    ['--name--', 'name'],
  ];

  for (const [input, expected] of cases) {
    it(`slugify(${JSON.stringify(input)}) → ${JSON.stringify(expected)}`, () => {
      expect(slugify(input)).toBe(expected);
    });
  }

  it('produces only [a-z0-9-] characters', () => {
    const result = slugify('Hello World! Foto #1 @ 50%');
    expect(result).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('dedupeSlug', () => {
  it('returns base slug when no collision', () => {
    expect(dedupeSlug('library', new Set())).toBe('library');
  });

  it('appends -2 on first collision', () => {
    expect(dedupeSlug('library', new Set(['library']))).toBe('library-2');
  });

  it('appends -3 on second collision', () => {
    expect(dedupeSlug('library', new Set(['library', 'library-2']))).toBe('library-3');
  });

  it('skips already-taken suffixes', () => {
    const taken = new Set(['library', 'library-2', 'library-3']);
    expect(dedupeSlug('library', taken)).toBe('library-4');
  });
});

describe('LibrarySlugRegistry session fallback', () => {
  it('keeps an opened handle readable when IndexedDB is unavailable', async () => {
    const globalWithIdb = globalThis as typeof globalThis & { indexedDB?: IDBFactory };
    const original = globalWithIdb.indexedDB;
    Reflect.deleteProperty(globalWithIdb, 'indexedDB');
    try {
      const registry = new LibrarySlugRegistry();
      const handle = {
        kind: 'directory',
        name: 'Writable Photos',
        isSameEntry: async (other: FileSystemHandle) => other === handle,
      } as unknown as FileSystemDirectoryHandle;

      const slug = await registry.register(handle);

      expect(slug).toBe('writable-photos');
      expect(await registry.getHandle(slug)).toBe(handle);
      expect(await registry.list()).toContainEqual({
        slug: 'writable-photos',
        name: 'Writable Photos',
      });
    } finally {
      if (original) globalWithIdb.indexedDB = original;
      else Reflect.deleteProperty(globalWithIdb, 'indexedDB');
    }
  });

  it('mints a deduplicated slug when an existing handle rejects identity comparison', async () => {
    const globalWithIdb = globalThis as typeof globalThis & { indexedDB?: IDBFactory };
    const original = globalWithIdb.indexedDB;
    Reflect.deleteProperty(globalWithIdb, 'indexedDB');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const registry = new LibrarySlugRegistry();
      const revokedComparison = vi.fn().mockRejectedValue(new DOMException('Permission denied'));
      const revokedHandle = {
        kind: 'directory',
        name: 'Writable Photos',
        isSameEntry: revokedComparison,
      } as unknown as FileSystemDirectoryHandle;
      const newHandle = {
        kind: 'directory',
        name: 'Writable Photos',
        isSameEntry: async (other: FileSystemHandle) => other === newHandle,
      } as unknown as FileSystemDirectoryHandle;

      expect(await registry.register(revokedHandle)).toBe('writable-photos');

      const slug = await registry.register(newHandle);

      expect(revokedComparison).toHaveBeenCalledWith(newHandle);
      expect(slug).toBe('writable-photos-2');
      expect(await registry.getHandle(slug)).toBe(newHandle);
      expect(await registry.list()).toContainEqual({
        slug: 'writable-photos-2',
        name: 'Writable Photos',
      });
    } finally {
      warn.mockRestore();
      if (original) globalWithIdb.indexedDB = original;
      else Reflect.deleteProperty(globalWithIdb, 'indexedDB');
    }
  });

  it('keeps the same slug for one fallback handle and reconstructed persisted wrappers', async () => {
    const registry = new LibrarySlugRegistry();
    const folder = {
      name: 'Summer Photos',
      read: true,
      write: false,
      persistedKey: 'saved-summer',
    };

    expect(await registry.registerFallback(folder)).toBe('summer-photos');
    expect(await registry.registerFallback(folder)).toBe('summer-photos');
    expect(
      await registry.registerFallback({
        ...folder,
        name: 'Renamed wrapper',
      }),
    ).toBe('summer-photos');
  });

  it('deduplicates distinct fallback folders with equal or normalization-equivalent names', async () => {
    const registry = new LibrarySlugRegistry();

    expect(
      await registry.registerFallback({ name: 'Summer Photos', read: true, write: false }),
    ).toBe('summer-photos');
    expect(
      await registry.registerFallback({ name: 'Summer Photos', read: true, write: false }),
    ).toBe('summer-photos-2');
    expect(
      await registry.registerFallback({ name: 'summer---photos', read: true, write: false }),
    ).toBe('summer-photos-3');
  });
});
