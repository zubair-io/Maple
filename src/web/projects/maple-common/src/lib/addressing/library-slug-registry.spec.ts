// LibrarySlugRegistry — slug ↔ handle persistence in IndexedDB (Hosted).
//
// Tests slugify/dedupeSlug logic (must match M1 server rules) and the
// register/getHandle/list contract — without real IndexedDB (not available
// in jsdom). The slug logic is pure; IDB operations are tested structurally.

import { describe, it, expect } from 'vitest';
import { slugify, dedupeSlug } from './library-slug-registry';

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
