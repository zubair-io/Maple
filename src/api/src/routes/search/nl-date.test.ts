/**
 * Table-driven tests for the conservative natural-language date parser.
 * Pure logic — no Mongo, no Meili. `now` is pinned so "no-year" forms
 * resolve deterministically.
 */

import { describe, it, expect } from 'bun:test';
import { parseNlDateRange } from './nl-date.ts';

// Pinned "today" — Tuesday 2026-05-26 (matches the harness fixture date).
const NOW = new Date('2026-05-26T12:00:00.000Z');

describe('parseNlDateRange — recognised forms', () => {
  it('bare year → whole-year range', () => {
    expect(parseNlDateRange('2023', NOW)).toEqual({
      from: '2023-01-01',
      to: '2023-12-31',
      matched: '2023',
    });
  });

  it('"May 5" with no year → most recent past occurrence', () => {
    // May 5 2026 is before today (May 26 2026), so it resolves to 2026.
    expect(parseNlDateRange('May 5', NOW)).toEqual({
      from: '2026-05-05',
      to: '2026-05-05',
      matched: 'may 5',
    });
  });

  it('a no-year day later in the year resolves to last year', () => {
    // December 25 is after today (May 26), so the most recent occurrence is
    // last year.
    expect(parseNlDateRange('December 25', NOW)).toEqual({
      from: '2025-12-25',
      to: '2025-12-25',
      matched: 'december 25',
    });
  });

  it('"May 5, 2024" → that exact day', () => {
    expect(parseNlDateRange('May 5, 2024', NOW)).toEqual({
      from: '2024-05-05',
      to: '2024-05-05',
      matched: 'may 5, 2024',
    });
  });

  it('"May 2024" → whole month', () => {
    expect(parseNlDateRange('May 2024', NOW)).toEqual({
      from: '2024-05-01',
      to: '2024-05-31',
      matched: 'may 2024',
    });
  });

  it('"5 May 2024" (day-first) → that exact day', () => {
    const r = parseNlDateRange('5 May 2024', NOW);
    expect(r?.from).toBe('2024-05-05');
    expect(r?.to).toBe('2024-05-05');
  });

  // Holiday names are themes, not dates (#2952). Only the YEAR is consumed,
  // so "christmas" survives to be ranked against christmas-looking photos
  // from anywhere in 2024 — not just whatever was shot on Dec 25.
  it('"Christmas 2024" → whole year, holiday word left to rank', () => {
    expect(parseNlDateRange('Christmas 2024', NOW)).toEqual({
      from: '2024-01-01',
      to: '2024-12-31',
      matched: '2024',
    });
  });

  // Bare "Christmas" used to resolve to the most recent Dec 25. It no longer
  // parses as a date at all — the word describes what a photo shows, and
  // consuming it left the query with no search text to rank. See the #2952
  // block below for the full reasoning.

  it('"last summer" → previous year June–August', () => {
    expect(parseNlDateRange('last summer', NOW)).toEqual({
      from: '2025-06-01',
      to: '2025-08-31',
      matched: 'last summer',
    });
  });

  it('"summer 2024" → that year June–August', () => {
    expect(parseNlDateRange('summer 2024', NOW)).toEqual({
      from: '2024-06-01',
      to: '2024-08-31',
      matched: 'summer 2024',
    });
  });

  it('"winter 2024" wraps Dec 2023 – Feb 2024', () => {
    expect(parseNlDateRange('winter 2024', NOW)).toEqual({
      from: '2023-12-01',
      to: '2024-02-29', // 2024 is a leap year
      matched: 'winter 2024',
    });
  });

  it('embedded ISO date is recognised', () => {
    const r = parseNlDateRange('2024-07-04', NOW);
    expect(r?.from).toBe('2024-07-04');
    expect(r?.to).toBe('2024-07-04');
  });

  it('extracts the date from a mixed query, leaving matched for stripping', () => {
    const r = parseNlDateRange('beach May 2024', NOW);
    expect(r?.from).toBe('2024-05-01');
    expect(r?.to).toBe('2024-05-31');
    expect(r?.matched).toBe('may 2024');
  });
});

describe('parseNlDateRange — must NOT match', () => {
  it('plain text is not a date', () => {
    expect(parseNlDateRange('a boy playing ball', NOW)).toBeNull();
    expect(parseNlDateRange('Greyson', NOW)).toBeNull();
    expect(parseNlDateRange('sunset over the bay', NOW)).toBeNull();
  });

  it('a small bare number is not a year', () => {
    // "ISO 5" must not pull "5" out as a date — there is no year/month form.
    expect(parseNlDateRange('iso 5', NOW)).toBeNull();
    expect(parseNlDateRange('5', NOW)).toBeNull();
  });

  it('an out-of-era number is not a year', () => {
    // High ISO values shouldn't read as years.
    expect(parseNlDateRange('iso 6400', NOW)).toBeNull();
    expect(parseNlDateRange('100', NOW)).toBeNull();
  });

  it('an impossible day-of-month does not match the month form', () => {
    // "may 99" has no valid day; the parser falls through to non-date.
    expect(parseNlDateRange('may 99 something', NOW)).toBeNull();
  });

  it('empty / whitespace is null', () => {
    expect(parseNlDateRange('', NOW)).toBeNull();
    expect(parseNlDateRange('   ', NOW)).toBeNull();
  });
});

/**
 * #2952 — a bare season or holiday word used to consume the whole query.
 * `winter` became a Dec–Feb window with NO search text left, so
 * `usesPlaceText()` went false, Meilisearch was never queried, and the route
 * returned "everything captured last winter, newest first" with no relevance
 * ranking at all. The reported top hit for `winter` was a golf-app screenshot
 * captured on the window's final day.
 *
 * These words describe how a photo LOOKS, so they belong to the text query
 * and to semantic search — across every year. Temporal intent still wins when
 * the user states it (`last winter`, `winter 2024`).
 */
describe('parseNlDateRange — bare season and holiday words stay searchable', () => {
  it.each(['winter', 'summer', 'spring', 'fall', 'autumn'])(
    'bare "%s" is not a date range',
    (season) => {
      expect(parseNlDateRange(season, NOW)).toBeNull();
    },
  );

  it.each(['christmas', 'halloween'])('bare "%s" is not a date range', (holiday) => {
    expect(parseNlDateRange(holiday, NOW)).toBeNull();
  });

  it('leaves a season word in place alongside other search terms', () => {
    // Previously clamped to the current winter, which hid skiing photos from
    // every earlier season no matter how well tagged.
    expect(parseNlDateRange('winter skiing', NOW)).toBeNull();
  });

  it('is case-insensitive about it', () => {
    expect(parseNlDateRange('Winter', NOW)).toBeNull();
  });

  it('still parses an explicit "last winter"', () => {
    expect(parseNlDateRange('last winter', NOW)).toEqual({
      from: '2024-12-01',
      to: '2025-02-28',
      matched: 'last winter',
    });
  });

  it('still parses an explicit "this summer"', () => {
    expect(parseNlDateRange('this summer', NOW)).toEqual({
      from: '2026-06-01',
      to: '2026-08-31',
      matched: 'this summer',
    });
  });

  it('still parses a year-qualified season', () => {
    expect(parseNlDateRange('summer 2024', NOW)).toEqual({
      from: '2024-06-01',
      to: '2024-08-31',
      matched: 'summer 2024',
    });
  });

  it('consumes only the year from a year-qualified holiday', () => {
    expect(parseNlDateRange('christmas 2024', NOW)).toEqual({
      from: '2024-01-01',
      to: '2024-12-31',
      matched: '2024',
    });
  });

  /** Months and years are unambiguously temporal — unchanged by #2952.
   * A bare month resolves to the most RECENT one (never the future), which
   * from a May 2026 "today" is August 2025. */
  it('leaves a bare month parsing as a date', () => {
    expect(parseNlDateRange('august', NOW)).toEqual({
      from: '2025-08-01',
      to: '2025-08-31',
      matched: 'august',
    });
  });

  it('leaves a bare year parsing as a date', () => {
    expect(parseNlDateRange('2024', NOW)).toEqual({
      from: '2024-01-01',
      to: '2024-12-31',
      matched: '2024',
    });
  });
});
