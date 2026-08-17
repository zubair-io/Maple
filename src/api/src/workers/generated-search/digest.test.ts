/**
 * Pure unit tests for `credibleYears` — the filter standing between raw
 * per-year asset counts and the coverage block the model is shown.
 *
 * Two independent failure modes, both measured on the live library
 * (333,860 assets, 2026-08-16), and neither catches the other:
 *
 *   - **Epoch sentinels.** 1,931 assets carry 1899, the OLE/Excel epoch
 *     (1899-12-30) leaking out of unparseable EXIF. A volume threshold
 *     cannot catch this — 1,931 assets clears any plausible floor, and a
 *     "Turn of the Century" collection would pass every downstream
 *     validation gate while being pure garbage.
 *   - **Thin years.** 1971×1, 1988×1, 1992×2, 1995×5. Real timestamps,
 *     probably, but too few photos to build a collection from. A sentinel
 *     list cannot catch these because the years are unremarkable.
 *
 * Getting this wrong is expensive downstream: the worker reads result
 * count as its quality signal, so a garbage year that clears the floor is
 * indistinguishable from a good one.
 */

import { describe, it, expect } from 'bun:test';
import { credibleYears, MIN_YEAR_ASSETS } from './digest.ts';

/** Trimmed shape of the real library's per-year histogram. */
const LIVE_SAMPLE = [
  { year: 1899, count: 1931 },
  { year: 1971, count: 1 },
  { year: 1988, count: 1 },
  { year: 1992, count: 2 },
  { year: 1995, count: 5 },
  { year: 2005, count: 3504 },
  { year: 2016, count: 49308 },
  { year: 2026, count: 3828 },
];

describe('credibleYears', () => {
  it('drops the 1899 OLE-epoch sentinel despite its high count', () => {
    // The whole point: 1,931 assets would clear any volume threshold.
    expect(credibleYears([{ year: 1899, count: 1931 }])).toEqual([]);
  });

  it('drops the other known epoch sentinels', () => {
    const sentinels = [1900, 1904, 1970].map((year) => ({ year, count: 5000 }));
    expect(credibleYears(sentinels)).toEqual([]);
  });

  it('drops years with too few photos to build a collection from', () => {
    expect(credibleYears([{ year: 1992, count: 2 }])).toEqual([]);
  });

  it('keeps a year sitting exactly on the floor', () => {
    expect(credibleYears([{ year: 1980, count: MIN_YEAR_ASSETS }])).toEqual([1980]);
  });

  it('keeps only the credible years from a live sample, ascending', () => {
    expect(credibleYears(LIVE_SAMPLE)).toEqual([2005, 2016, 2026]);
  });

  it('sorts ascending regardless of input order', () => {
    const shuffled = [
      { year: 2020, count: 900 },
      { year: 2016, count: 900 },
      { year: 2018, count: 900 },
    ];
    expect(credibleYears(shuffled)).toEqual([2016, 2018, 2020]);
  });

  it('returns an empty list for empty input rather than throwing', () => {
    expect(credibleYears([])).toEqual([]);
  });
});
