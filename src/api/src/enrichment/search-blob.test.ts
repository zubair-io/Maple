/**
 * Pure-function tests for `composeSearchBlob` + the Mongo aggregation
 * expression shape. The aggregation pipeline is also exercised end-to-
 * end inside `ocr-worker.test.ts` against a real Mongo — these tests
 * cover only the pure logic.
 */

import { describe, it, expect } from 'bun:test';
import { composeSearchBlob, searchBlobUpdateExpression, seasonForMonth } from './search-blob.ts';
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

describe('searchBlobUpdateExpression', () => {
  it('with no overrides, references all three field paths', () => {
    const expr = searchBlobUpdateExpression();
    const json = JSON.stringify(expr);
    // Each source pulls from the row's current value.
    expect(json).toContain('$place.search_blob');
    expect(json).toContain('$description');
    expect(json).toContain('$ocr_text');
    // Pipeline shape: a $reduce whose input is a $sortArray over a $setUnion.
    expect(expr).toHaveProperty('$reduce');
    const reduce = (expr as { $reduce: Record<string, unknown> }).$reduce;
    expect(reduce.initialValue).toBe('');
    expect(reduce.input).toHaveProperty('$sortArray');
    // Tokenisation must handle CRLF/LF/CR/tab — the OCR text frequently
    // contains newlines, and Mongo `$split` only splits on the literal
    // delimiter so the expression has to pre-normalise.
    expect(json).toContain('\\r\\n');
    expect(json).toContain('\\n');
    expect(json).toContain('\\t');
  });

  it('supplied placeSearchBlob override replaces the field path', () => {
    const expr = searchBlobUpdateExpression({
      placeSearchBlob: 'custom one two',
    });
    const json = JSON.stringify(expr);
    // Place override is in-line; the path is no longer referenced.
    expect(json).toContain('custom one two');
    expect(json).not.toContain('$place.search_blob');
    // Other two stay as field references.
    expect(json).toContain('$description');
    expect(json).toContain('$ocr_text');
  });

  it('supplied description and ocrText overrides replace those paths', () => {
    const expr = searchBlobUpdateExpression({
      description: 'a cat',
      ocrText: 'TEXT 1',
    });
    const json = JSON.stringify(expr);
    expect(json).toContain('a cat');
    expect(json).toContain('TEXT 1');
    expect(json).not.toContain('$description');
    expect(json).not.toContain('$ocr_text');
    // Place falls back to field reference.
    expect(json).toContain('$place.search_blob');
  });

  it("null override means 'no contribution from this source'", () => {
    const expr = searchBlobUpdateExpression({
      ocrText: null,
      description: null,
      placeSearchBlob: null,
    });
    const json = JSON.stringify(expr);
    // Field paths must not be referenced — every source is overridden.
    expect(json).not.toContain('$place.search_blob');
    expect(json).not.toContain('$description');
    expect(json).not.toContain('$ocr_text');
  });

  it('people override folds tokenised names into the union', () => {
    const expr = searchBlobUpdateExpression({
      people: ['Greyson', 'Maya Smith'],
    });
    const json = JSON.stringify(expr);
    // Names are tokenised + lowercased and unioned in as a literal array.
    expect(json).toContain('greyson');
    expect(json).toContain('maya');
    expect(json).toContain('smith');
  });

  // #2992: the aggregation form reads $exif.captured_month directly — there
  // is no override for it, unlike place/description/ocrText, since no
  // caller of this expression is ever mid-write on captured_month itself.
  it('references $exif.captured_month and every season word, with no override', () => {
    const expr = searchBlobUpdateExpression();
    const json = JSON.stringify(expr);
    expect(json).toContain('$exif.captured_month');
    expect(json).toContain('winter');
    expect(json).toContain('spring');
    expect(json).toContain('summer');
    expect(json).toContain('fall');
  });

  it('still references $exif.captured_month when other sources are overridden', () => {
    const expr = searchBlobUpdateExpression({ description: 'a cat', ocrText: null });
    expect(JSON.stringify(expr)).toContain('$exif.captured_month');
  });
});
