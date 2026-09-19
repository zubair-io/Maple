/**
 * The recurring month-of-year filter — what makes "August, every year"
 * expressible.
 *
 * `from`/`to` compile to a single continuous range over the capture date, so
 * they cannot express "this month across every year": `from=2014-08-01&
 * to=2019-08-31` matches the whole five-year span. `month` filters the
 * pre-extracted month-of-year column instead, and composes with a date range
 * rather than replacing it.
 *
 * Pure unit tests against `buildSearchWhere`, mirroring `hidden-people.test.ts`.
 */

import { describe, it, expect } from 'bun:test';
import { buildSearchWhere } from '../../db/sqlite/repos/search.where.ts';
import type { SearchQuery } from './query.ts';

const MONTH_CLAUSE = 'assets.captured_month = ?';

/** What a query compiles to, unwrapped so a case can assert on it. */
function whereFor(q: SearchQuery): { clauses: string; params: readonly unknown[] } {
  const result = buildSearchWhere(q, []);
  if ('error' in result) throw new Error(`unexpected error: ${result.error}`);
  return { clauses: result.clauses.join(' AND '), params: result.params };
}

/** The value bound to the month predicate, or undefined when there is none. */
function boundMonth(q: SearchQuery): unknown {
  const result = buildSearchWhere(q, []);
  if ('error' in result) throw new Error(`unexpected error: ${result.error}`);
  const index = result.clauses.indexOf(MONTH_CLAUSE);
  if (index === -1) return undefined;
  // One placeholder per clause up to this one, so the parameter index is the
  // count of `?` in everything before it.
  const before = result.clauses.slice(0, index).join(' ');
  return result.params[(before.match(/\?/g) ?? []).length];
}

describe('month', () => {
  it('adds no month constraint when the caller says nothing', () => {
    expect(whereFor({}).clauses).not.toContain('captured_month');
  });

  it('filters on the pre-extracted month number', () => {
    expect(whereFor({ month: '8' }).clauses).toContain(MONTH_CLAUSE);
    expect(boundMonth({ month: '8' })).toBe(8);
  });

  it('accepts every month in range', () => {
    for (let m = 1; m <= 12; m += 1) {
      expect(boundMonth({ month: String(m) })).toBe(m);
    }
  });

  it('ignores out-of-range and non-numeric months', () => {
    // A junk value must not become a filter that silently matches nothing —
    // an empty collection is worse than an unfiltered one here, because the
    // generated-search worker reads the result count as a quality signal.
    for (const bad of ['0', '13', '-1', 'august', '', '8.5']) {
      expect(whereFor({ month: bad }).clauses).not.toContain('captured_month');
    }
  });

  it('composes with a date range instead of replacing it', () => {
    // The combination is the point: "Augusts since 2015" is `month=8` AND a
    // `from` bound. Losing either would silently widen the collection.
    const { clauses, params } = whereFor({ month: '8', from: '2015-01-01' });
    expect(clauses).toContain(MONTH_CLAUSE);
    expect(clauses).toContain('assets.captured_at >= ?');
    expect(params).toContain('2015-01-01T00:00:00.000Z');
    expect(boundMonth({ month: '8', from: '2015-01-01' })).toBe(8);
  });

  it('composes with the hidden-image default', () => {
    const { clauses } = whereFor({ month: '8' });
    expect(clauses).toContain('assets.hidden = 0');
    expect(clauses).toContain(MONTH_CLAUSE);
  });
});
