/**
 * The query string → `WHERE` translation.
 *
 * The first half is validation. `buildSearchWhere` answers `{ error }` for
 * seven kinds of malformed query and the route turns each into a 400 with that
 * sentence in the body, so the exact wording is part of the wire contract — as
 * is which message wins when a query is wrong in two ways at once, since only
 * one is reported. Both are pinned case by case below.
 */

import { describe, expect, test } from 'bun:test';
import { buildSearchWhere, searchWhereSql } from './search.where.ts';
import type { SearchQuery } from '../../routes/search/query-schema.ts';

/**
 * Every query that must be rejected paired with the sentence it earns, and
 * every near-miss that must be accepted paired with `null`.
 *
 * The five doubly-wrong queries in the middle exist for the ordering: the
 * checks run libraryId → flag → colour → pathPrefix → sceneType → extensions →
 * scope, so each of those pairs proves the earlier check is the one that
 * reports. Change the order and exactly one of them fails.
 */
const VALIDATION_CASES: ReadonlyArray<readonly [SearchQuery, string | null]> = [
  [{ libraryId: 'not-an-object-id' }, 'Invalid libraryId'],
  [{ flag: 'maybe' }, 'Invalid flag: maybe'],
  [{ color: 'chartreuse' }, 'Invalid color: chartreuse'],
  [{ pathPrefix: 'x'.repeat(1025) }, 'pathPrefix too long'],
  [{ sceneType: 'underwater' }, 'Invalid sceneType: underwater'],
  [{ ext: 'dng,../etc' }, 'Invalid extension: ../etc'],
  [{ ext: 'DNG' }, null],
  [{ scope: 'albums' }, null],
  [{ scope: 'nonsense' }, 'Invalid scope: nonsense'],
  // Wrong in two ways: the earlier check is the one that reports.
  [{ libraryId: 'bad', flag: 'maybe' }, 'Invalid libraryId'],
  [{ flag: 'maybe', color: 'chartreuse' }, 'Invalid flag: maybe'],
  [{ color: 'chartreuse', sceneType: 'underwater' }, 'Invalid color: chartreuse'],
  [{ sceneType: 'underwater', ext: '../etc' }, 'Invalid sceneType: underwater'],
  [{ ext: '../etc', scope: 'nonsense' }, 'Invalid extension: ../etc'],
  // Accepted: an empty flag, an empty colour, an empty scope, a valid trio.
  [{ flag: '' }, null],
  [{ color: '' }, null],
  [{ scope: '' }, null],
  [{ flag: 'pick', color: 'blue', scope: 'photos' }, null],
  [{}, null],
];

describe('buildSearchWhere — which queries earn a 400, and with which sentence', () => {
  for (const [query, expected] of VALIDATION_CASES) {
    test(JSON.stringify(query), () => {
      const where = buildSearchWhere(query);
      expect('error' in where ? where.error : null).toBe(expected);
    });
  }
});

describe('buildSearchWhere — the clause list', () => {
  test('an empty query carries no residual at all, only the visibility field', () => {
    const where = buildSearchWhere({});
    if ('error' in where) throw new Error(where.error);
    // The always-on hidden filter is a field rather than a clause (#3768):
    // an empty clause list is what tells a satellite facet it can answer from
    // its own index instead of joining `assets`.
    expect(where.clauses).toEqual([]);
    expect(where.hidden).toBe(0);
    expect(where.params).toEqual([]);
    expect(where.match).toEqual({ kind: 'none' });
    expect(searchWhereSql(where).sql).toBe(
      'WHERE assets.deleted_at IS NULL AND assets.live_location_count > 0\n     AND assets.hidden = 0',
    );
  });

  test('the live predicate always comes first, and a text match before it', () => {
    const where = buildSearchWhere({ placeQuery: 'harbour', rating: '3' });
    if ('error' in where) throw new Error(where.error);
    const { sql, params } = searchWhereSql(where);
    expect(sql.startsWith('WHERE assets_fts MATCH ?')).toBe(true);
    expect(sql).toContain('assets.deleted_at IS NULL AND assets.live_location_count > 0');
    // The MATCH expression binds first, because its placeholder is first.
    expect(params[0]).toBe('(("harbour"))');
    expect(params[1]).toBe(3);
  });

  test('every clause binds exactly the parameters its placeholders expect', () => {
    const where = buildSearchWhere(
      {
        q: 'dji',
        camera: 'Apple',
        lens: '24-70',
        place: 'Albany, New York|Kyoto',
        isoMin: '100',
        isoMax: '800',
        apertureMin: '1.4',
        focalMin: '24',
        from: '2024-01-01',
        to: '2024-12-31',
        month: '6',
        rating: '3',
        flag: 'pick',
        color: 'blue',
        pathPrefix: '/trips/2024/',
        sceneType: 'outdoor',
        activity: 'sailing',
        subjects: 'boat,water',
        ext: 'dng,jpg',
        scope: 'people',
        placeQuery: 'harbour',
      },
      ['aaaaaaaaaaaaaaaaaaaaaaaa'],
      ['bbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccccccc'],
    );
    if ('error' in where) throw new Error(where.error);
    const { sql, params } = searchWhereSql(where);
    expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
  });

  test('a user wildcard in free text is escaped, not honoured', () => {
    const where = buildSearchWhere({ q: '100%_raw' });
    if ('error' in where) throw new Error(where.error);
    expect(where.params).toEqual(['%100\\%\\_raw%', '%100\\%\\_raw%']);
  });

  test('a path prefix matches the directory and its descendants only', () => {
    const where = buildSearchWhere({ pathPrefix: '/A/' });
    if ('error' in where) throw new Error(where.error);
    expect(where.params).toEqual(['A', 'A/', 'A/']);
  });

  test('a bare place label matches either half with the other blank', () => {
    const where = buildSearchWhere({ place: 'Kyoto' });
    if ('error' in where) throw new Error(where.error);
    expect(where.clauses[0]).toContain('assets.place_locality = ?');
    expect(where.clauses[0]).toContain("assets.place_region IS NULL OR assets.place_region = ''");
    expect(where.params).toEqual(['Kyoto', 'Kyoto']);
  });

  test('a "locality, region" label splits on the last comma', () => {
    const where = buildSearchWhere({ place: 'Washington, D.C., District of Columbia' });
    if ('error' in where) throw new Error(where.error);
    expect(where.params).toEqual(['Washington, D.C.', 'District of Columbia']);
  });

  test('names that resolved to nobody match nothing, not everything', () => {
    const where = buildSearchWhere({}, [], []);
    if ('error' in where) throw new Error(where.error);
    // An empty `IN ()` rather than a constant false — see the note on
    // `peopleTerm`, and the "no query solution" failure the constant causes.
    expect(where.clauses[0]).toContain('f.person_id IN ()');
  });

  test('hidden is excluded by default, included by "all", required by "only"', () => {
    const visibility = (hidden?: string): { field: 0 | 1 | null; sql: string } => {
      const where = buildSearchWhere(hidden === undefined ? {} : { hidden });
      if ('error' in where) throw new Error(where.error);
      expect(where.clauses).toEqual([]);
      return { field: where.hidden, sql: searchWhereSql(where).sql };
    };
    expect(visibility().field).toBe(0);
    expect(visibility('none').field).toBe(0);
    expect(visibility('all').field).toBeNull();
    expect(visibility('only').field).toBe(1);

    // And the field still reaches the statement, in the spelling every
    // partial index on `assets` was built around.
    expect(visibility().sql).toContain('assets.hidden = 0');
    expect(visibility('only').sql).toContain('assets.hidden = 1');
    expect(visibility('all').sql).not.toContain('assets.hidden');
  });

  test('isScreenshot=false matches the unclassified, not only the classified', () => {
    // is_screenshot is tri-state: NULL means the describe stage has not looked
    // at this asset yet. `= 0` would exclude those, so on a library that is
    // mid-enrichment the photographs filter would return almost nothing — and
    // the generated-search worker forces isScreenshot: 'false' on every query
    // it evaluates, so it would have scored every collection it proposed at
    // zero. `IS NOT 1` is the one spelling that keeps NULL in the set.
    const where = buildSearchWhere({ isScreenshot: 'false' });
    if ('error' in where) throw new Error(where.error);
    expect(where.clauses).toContain('assets.is_screenshot IS NOT 1');
    expect(where.clauses).not.toContain('assets.is_screenshot = 0');

    const only = buildSearchWhere({ isScreenshot: 'true' });
    if ('error' in only) throw new Error(only.error);
    expect(only.clauses).toContain('assets.is_screenshot = 1');
  });

  test('an out-of-range month is dropped rather than matching nothing', () => {
    // A filter that matches nothing is worse than no filter here: the
    // generated-search worker reads the result count as a quality signal.
    for (const month of ['0', '13', '6.5', 'june']) {
      const where = buildSearchWhere({ month });
      if ('error' in where) throw new Error(where.error);
      expect(where.clauses).toEqual([]);
    }
    const valid = buildSearchWhere({ month: '6' });
    if ('error' in valid) throw new Error(valid.error);
    expect(valid.clauses).toEqual(['assets.captured_month = ?']);
  });

  test('bare dates widen to the whole day at both ends', () => {
    // `to: '2024-12-31'` compares lexicographically below every timestamp
    // recorded on that day, so without widening the last day of the range
    // silently drops out of the results.
    const where = buildSearchWhere({ from: '2024-01-01', to: '2024-12-31' });
    if ('error' in where) throw new Error(where.error);
    expect(where.params).toEqual(['2024-01-01T00:00:00.000Z', '2024-12-31T23:59:59.999Z']);
  });
});
