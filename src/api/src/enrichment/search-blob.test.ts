/**
 * Pure-function tests for `composeSearchBlob`.
 * These tests cover only the pure logic.
 */

import { describe, it, expect } from 'bun:test';
import { composeSearchBlob, seasonForMonth } from './search-blob.ts';
import type { Place } from '../db/schema.ts';

function placeWith(blob: string): Place {
  return {
    source: 'nominatim',
    geocoder_version: 1,
    geocoded_at: '2026-05-09T00:00:00.000Z',
    lat: 0,
    lon: 0,
    display_name: null,
    address: {},
    pois: [],
    rollups: { locality: null, region: null, country_code: null },
    search_blob: blob,
  };
}

describe('composeSearchBlob', () => {
  it('folds transcript words into the blob', () => {
    expect(composeSearchBlob({ transcript: 'General Kenobi hello there' }).split(' ')).toEqual(
      expect.arrayContaining(['general', 'kenobi', 'hello', 'there']),
    );
  });
  it('returns empty string when every source is empty/missing', () => {
    expect(composeSearchBlob({})).toBe('');
    expect(composeSearchBlob({ place: null, description: null, ocrText: null })).toBe('');
    expect(composeSearchBlob({ description: '', ocrText: '' })).toBe('');
  });

  it('uses just the place blob when only place is set', () => {
    const out = composeSearchBlob({ place: placeWith('albany ny museum') });
    expect(out).toBe('albany museum ny');
  });

  it('merges all three sources, lowercases, dedups, and sorts', () => {
    const out = composeSearchBlob({
      place: placeWith('albany ny museum'),
      description: 'A photograph of the New York State Museum exterior',
      ocrText: 'MUSEUM ENTRANCE — ALBANY',
    });
    const tokens = out.split(' ');
    // Sorted alphabetically.
    expect(tokens).toEqual([...tokens].sort());
    // Dedup: "albany" + "museum" came from multiple sources and appear once.
    expect(tokens.filter((t) => t === 'albany').length).toBe(1);
    expect(tokens.filter((t) => t === 'museum').length).toBe(1);
    // Spot-check tokens from each source.
    expect(tokens).toContain('albany');
    expect(tokens).toContain('ny');
    expect(tokens).toContain('museum');
    expect(tokens).toContain('photograph');
    expect(tokens).toContain('entrance');
  });

  it('handles description-only input cleanly', () => {
    const out = composeSearchBlob({
      description: 'Two cats on a windowsill',
    });
    expect(out.split(' ').sort()).toEqual(['a', 'cats', 'on', 'two', 'windowsill']);
  });

  it('handles ocr-only input cleanly', () => {
    const out = composeSearchBlob({
      ocrText: 'Welcome\nto\tMaple',
    });
    // Tabs/newlines are whitespace.
    expect(out.split(' ').sort()).toEqual(['maple', 'to', 'welcome']);
  });

  it('does not crash on weird whitespace and punctuation', () => {
    const out = composeSearchBlob({
      ocrText: '  Hello   World  \r\n  ',
      description: '  ',
    });
    expect(out).toBe('hello world');
  });

  it('folds in vision subjects / setting / activity / notable_objects', () => {
    const out = composeSearchBlob({
      description: 'A child sprinting across a green field.',
      visionSubjects: ['person', 'child', 'athlete'],
      visionSetting: 'sports field',
      visionActivity: 'lacrosse',
      visionNotableObjects: ['lacrosse stick', 'helmet'],
    });
    const tokens = new Set(out.split(' '));
    // Multi-word strings tokenise per-word.
    expect(tokens.has('sports')).toBe(true);
    expect(tokens.has('field')).toBe(true);
    expect(tokens.has('lacrosse')).toBe(true);
    expect(tokens.has('stick')).toBe(true);
    expect(tokens.has('helmet')).toBe(true);
    expect(tokens.has('child')).toBe(true);
    expect(tokens.has('athlete')).toBe(true);
  });

  // Prompt v7's keyword bag exists precisely to put terms in the blob that
  // the caption's prose never happens to contain, so the assertion that
  // matters is a tag word landing when nothing else supplies it.
  it('folds in vision tags, including terms absent from the caption', () => {
    const out = composeSearchBlob({
      description: 'A child sprinting across a green field.',
      visionTags: ['lacrosse', 'youth sports', 'cleats'],
    });
    const tokens = new Set(out.split(' '));
    expect(tokens.has('lacrosse')).toBe(true);
    expect(tokens.has('youth')).toBe(true);
    expect(tokens.has('sports')).toBe(true);
    expect(tokens.has('cleats')).toBe(true);
  });

  // Rows captioned before v7 have no `tags`. Passing null must be
  // indistinguishable from not passing the field at all.
  it('treats null / omitted vision tags as no contribution', () => {
    const withNull = composeSearchBlob({ description: 'Two cats', visionTags: null });
    const omitted = composeSearchBlob({ description: 'Two cats' });
    expect(withNull).toBe(omitted);
  });

  it('vision arrays of length 0 contribute no tokens', () => {
    const out = composeSearchBlob({
      description: 'Two cats on a windowsill',
      visionSubjects: [],
      visionNotableObjects: [],
      visionSetting: null,
      visionActivity: null,
    });
    expect(out.split(' ').sort()).toEqual(['a', 'cats', 'on', 'two', 'windowsill']);
  });

  it('dedup applies across description + vision sources', () => {
    // "lacrosse" appears in both description and vision.activity.
    const out = composeSearchBlob({
      description: 'lacrosse game on the field',
      visionActivity: 'lacrosse',
      visionSubjects: ['athlete'],
    });
    expect(out.split(' ').filter((t) => t === 'lacrosse').length).toBe(1);
  });

  it('folds in named people, tokenising multi-word names', () => {
    const out = composeSearchBlob({
      description: 'kids at the park',
      people: ['Greyson', 'Maya Smith'],
    });
    const tokens = new Set(out.split(' '));
    expect(tokens.has('greyson')).toBe(true);
    expect(tokens.has('maya')).toBe(true);
    expect(tokens.has('smith')).toBe(true);
  });

  it('empty / null people contribute no tokens', () => {
    const out = composeSearchBlob({
      description: 'Two cats on a windowsill',
      people: [],
    });
    expect(out.split(' ').sort()).toEqual(['a', 'cats', 'on', 'two', 'windowsill']);
  });

  // #2992
  it('folds a season word derived from capturedMonth', () => {
    const out = composeSearchBlob({ description: 'ice skating', capturedMonth: 2 });
    expect(out.split(' ')).toContain('winter');
  });

  it('omits the season word when capturedMonth is missing or out of range', () => {
    expect(composeSearchBlob({ description: 'a cat' })).toBe('a cat');
    expect(composeSearchBlob({ description: 'a cat', capturedMonth: null })).toBe('a cat');
    expect(composeSearchBlob({ description: 'a cat', capturedMonth: 0 }).split(' ')).toEqual([
      'a',
      'cat',
    ]);
    expect(composeSearchBlob({ description: 'a cat', capturedMonth: 13 }).split(' ')).toEqual([
      'a',
      'cat',
    ]);
  });

  it('never indexes a month NAME — only the season', () => {
    const out = composeSearchBlob({ description: 'a cat', capturedMonth: 3 });
    expect(out).toBe('a cat spring');
    expect(out).not.toContain('march');
  });
});

describe('seasonForMonth', () => {
  it('maps every Northern-Hemisphere meteorological month to its season', () => {
    expect(seasonForMonth(12)).toBe('winter');
    expect(seasonForMonth(1)).toBe('winter');
    expect(seasonForMonth(2)).toBe('winter');
    expect(seasonForMonth(3)).toBe('spring');
    expect(seasonForMonth(4)).toBe('spring');
    expect(seasonForMonth(5)).toBe('spring');
    expect(seasonForMonth(6)).toBe('summer');
    expect(seasonForMonth(7)).toBe('summer');
    expect(seasonForMonth(8)).toBe('summer');
    expect(seasonForMonth(9)).toBe('fall');
    expect(seasonForMonth(10)).toBe('fall');
    expect(seasonForMonth(11)).toBe('fall');
  });

  it('returns null for missing or out-of-range input', () => {
    expect(seasonForMonth(null)).toBeNull();
    expect(seasonForMonth(undefined)).toBeNull();
    expect(seasonForMonth(0)).toBeNull();
    expect(seasonForMonth(13)).toBeNull();
    expect(seasonForMonth(1.5)).toBeNull();
  });
});
