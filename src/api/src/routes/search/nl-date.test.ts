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

  it('"Christmas 2024" → fixed holiday with year', () => {
    expect(parseNlDateRange('Christmas 2024', NOW)).toEqual({
      from: '2024-12-25',
      to: '2024-12-25',
      matched: 'christmas 2024',
    });
  });

  it('bare "Christmas" → most recent past occurrence', () => {
    // Dec 25 is after today (May), so most recent is 2025.
    const r = parseNlDateRange('Christmas', NOW);
    expect(r?.from).toBe('2025-12-25');
    expect(r?.to).toBe('2025-12-25');
  });

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
