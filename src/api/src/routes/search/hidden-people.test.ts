/**
 * Who a search is allowed to show: the always-on hidden-image default, and the
 * people whose photos are dropped from every result set.
 *
 * Pure unit tests against `buildSearchWhere`, which is deliberately pure — it
 * takes the person ids to drop as a parameter so the async lookups stay in the
 * route handlers. Since #2894 the OPT-IN decision lives in the callers too:
 * they always include `excludedPersonIds()` and add `hiddenPersonIds()` only
 * when the request carries `excludeHiddenPeople=true`; the builder itself
 * unconditionally applies whatever ids it is handed. Mirrors the fixture-only
 * pattern in `project.test.ts` / `nl-date.test.ts`.
 *
 * These cases live beside the route rather than beside the builder because the
 * guarantee they protect is a route-level one: a request that says nothing
 * about visibility must still not leak a hidden photo or a suppressed person.
 */

import { describe, it, expect } from 'bun:test';
import { buildSearchWhere, searchWhereSql } from '../../db/repos/search.where.ts';
import type { SearchQuery } from './query.ts';

/**
 * The `WHERE` a query compiles to, so a case can look for a fragment.
 *
 * Composed through `searchWhereSql` rather than by joining `where.clauses`,
 * because the always-on visibility filter is not a clause: #3768 lifted it to
 * the tri-state `where.hidden` field so a facet index can carry `asset_hidden`
 * as a column. `searchWhereSql` is what every statement calls, so asserting
 * against it tests the predicate that actually runs.
 */
function clausesFor(q: SearchQuery, excludedIds: string[] = []): string {
  const result = buildSearchWhere(q, excludedIds);
  if ('error' in result) throw new Error(`unexpected error: ${result.error}`);
  return searchWhereSql(result).sql;
}

/** The bound values, in order, for a case that cares which ids were bound. */
function paramsFor(q: SearchQuery, excludedIds: string[] = []): readonly unknown[] {
  const result = buildSearchWhere(q, excludedIds);
  if ('error' in result) throw new Error(`unexpected error: ${result.error}`);
  return result.params;
}

const HIDDEN_A = '651f1e4a2b3c4d5e6f708192';
const HIDDEN_B = '651f1e4a2b3c4d5e6f708193';

describe('hidden images (always on by default)', () => {
  it('excludes hidden images when the caller says nothing', () => {
    expect(clausesFor({})).toContain('assets.hidden = 0');
  });

  it('returns only hidden images for hidden=only', () => {
    expect(clausesFor({ hidden: 'only' })).toContain('assets.hidden = 1');
  });

  it('drops the hidden constraint entirely for hidden=all', () => {
    expect(clausesFor({ hidden: 'all' })).not.toContain('assets.hidden');
  });
});

describe('excluded-person ids (#2894: applied unconditionally)', () => {
  it('applies supplied ids regardless of any request flag — the caller owns the opt-in', () => {
    // Excluded people reach every route's id list unconditionally, so the
    // builder must not second-guess the flag.
    expect(clausesFor({}, [HIDDEN_A])).toContain('NOT (assets.id IN (SELECT f.asset_id FROM faces');
    expect(paramsFor({}, [HIDDEN_A])).toContain(HIDDEN_A);
    expect(clausesFor({ excludeHiddenPeople: 'false' }, [HIDDEN_A])).toContain(
      'NOT (assets.id IN (SELECT f.asset_id FROM faces',
    );
  });

  it('adds no faces constraint when the id list is empty', () => {
    // Guards the wasted-exclusion case: an empty id list must not produce a
    // `person_id IN ()`, which matches nothing and empties the feed.
    expect(clausesFor({ excludeHiddenPeople: 'true' }, [])).not.toContain('NOT (assets.id IN');
    expect(clausesFor({}, [])).not.toContain('NOT (assets.id IN');
  });

  it('excludes assets carrying a face of any listed person', () => {
    const params = paramsFor({ excludeHiddenPeople: 'true' }, [HIDDEN_A, HIDDEN_B]);
    expect(params).toContain(HIDDEN_A);
    expect(params).toContain(HIDDEN_B);
  });

  it('ignores a face the viewer hid on this asset', () => {
    // Hiding a face is a per-asset act, and it must not resurrect the person:
    // the sub-query is restricted to assigned, unhidden faces, so an asset
    // whose only face for this person is hidden no longer counts as showing
    // them.
    const clauses = clausesFor({}, [HIDDEN_A]);
    expect(clauses).toContain('f.person_id IS NOT NULL');
    expect(clauses).toContain('f.hidden = 0');
  });

  it('ANDs with scope=people instead of overwriting its presence check', () => {
    // `scope=people` asks for assets that have any face at all; the exclusion
    // removes the ones showing a suppressed person. Both must survive — losing
    // either would silently widen the People scope or drop the exclusion.
    const clauses = clausesFor({ scope: 'people', excludeHiddenPeople: 'true' }, [HIDDEN_A]);
    expect(clauses).toContain('assets.id IN (SELECT f.asset_id FROM faces f)');
    expect(clauses).toContain('NOT (assets.id IN (SELECT f.asset_id FROM faces');
  });

  it('composes with the hidden-image default rather than replacing it', () => {
    const clauses = clausesFor({ excludeHiddenPeople: 'true' }, [HIDDEN_A]);
    expect(clauses).toContain('assets.hidden = 0');
    expect(clauses).toContain('NOT (assets.id IN (SELECT f.asset_id FROM faces');
  });
});
