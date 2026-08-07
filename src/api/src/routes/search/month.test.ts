/**
 * Pure unit tests for `buildFilter`'s `month` handling — the recurring
 * month-of-year filter that makes "August, every year" expressible.
 *
 * `from`/`to` compile to a single continuous `$gte`/`$lte` range over the ISO
 * `exif.captured_at` string, so they cannot express "this month across every
 * year" — `from=2014-08-01&to=2019-08-31` matches the whole five-year span.
 * `month` filters the pre-extracted `exif.captured_month` number instead, and
 * composes with a date range rather than replacing it.
 *
 * No Mongo: `buildFilter` is pure, mirroring `hidden-people.test.ts`.
 */

import { describe, it, expect } from 'bun:test';
import { buildFilter, type SearchQuery } from './query.ts';

/** `buildFilter` returns a filter or an `{ error }`; unwrap for assertions. */
function filterFor(q: SearchQuery): Record<string, unknown> {
  const result = buildFilter(q, []);
  if ('error' in result) throw new Error(`unexpected error: ${result.error}`);
  return result as Record<string, unknown>;
}

describe('buildFilter — month', () => {
  it('adds no month constraint when the caller says nothing', () => {
    expect(filterFor({})['exif.captured_month']).toBeUndefined();
  });

  it('filters on the pre-extracted month number', () => {
    expect(filterFor({ month: '8' })['exif.captured_month']).toBe(8);
  });

  it('accepts every month in range', () => {
    for (let m = 1; m <= 12; m++) {
      expect(filterFor({ month: String(m) })['exif.captured_month']).toBe(m);
    }
  });

  it('ignores out-of-range and non-numeric months', () => {
    // A junk value must not become a filter that silently matches nothing —
    // an empty collection is worse than an unfiltered one here, because the
    // generated-search worker reads the result count as a quality signal.
    for (const bad of ['0', '13', '-1', 'august', '', '8.5']) {
      expect(filterFor({ month: bad })['exif.captured_month']).toBeUndefined();
    }
  });

  it('composes with a date range instead of replacing it', () => {
    // The combination is the point: "Augusts since 2015" is `month=8` AND a
    // `from` bound. Losing either would silently widen the collection.
    const filter = filterFor({ month: '8', from: '2015-01-01' });
    expect(filter['exif.captured_month']).toBe(8);
    expect(filter['exif.captured_at']).toMatchObject({ $gte: '2015-01-01T00:00:00.000Z' });
  });

  it('composes with the hidden-image default', () => {
    const filter = filterFor({ month: '8' });
    expect(filter.hidden).toEqual({ $ne: true });
    expect(filter['exif.captured_month']).toBe(8);
  });
});
