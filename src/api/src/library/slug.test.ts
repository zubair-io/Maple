import { describe, expect, it } from 'bun:test';
import { slugify, dedupeSlug } from './slug';

describe('slugify', () => {
  it('lowercases, hyphenates, strips punctuation', () => {
    expect(slugify('France 2026!')).toBe('france-2026');
    expect(slugify('  My/Photos  ')).toBe('my-photos');
    expect(slugify('Café déjà')).toBe('cafe-deja'); // diacritics folded
  });
  it('never returns empty', () => {
    expect(slugify('—')).toBe('library'); // fallback
    expect(slugify('')).toBe('library');
  });
  it('only emits [a-z0-9-]', () => {
    expect(slugify('A_B.C')).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('dedupeSlug', () => {
  it('returns base when free', () => {
    expect(dedupeSlug('france', new Set())).toBe('france');
  });
  it('appends -2, -3 on collision', () => {
    expect(dedupeSlug('france', new Set(['france']))).toBe('france-2');
    expect(dedupeSlug('france', new Set(['france', 'france-2']))).toBe('france-3');
  });
});
