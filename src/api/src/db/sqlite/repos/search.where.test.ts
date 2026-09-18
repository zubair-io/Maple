/**
 * The query string → `WHERE` translation, checked against the Mongo filter
 * builder it replaces.
 *
 * The important half is validation parity. `buildFilter` answers `{ error }`
 * for seven kinds of malformed query and the route turns each into a 400 with
 * that sentence in the body, so a client that reads the message keeps working
 * only if the messages match — including which one wins when a query is wrong
 * in two ways at once. Rather than restate the sentences here, each case is run
 * through both builders and their answers compared, so the parity cannot rot
 * without a test failing.
 */

import { describe, expect, test } from 'bun:test';
import { buildFilter } from '../../../routes/search/query.ts';
import { buildSearchWhere, searchWhereSql } from './search.where.ts';
import type { SearchQuery } from '../../../routes/search/query-schema.ts';

/** Queries that must be rejected, and the ones that must not. */
const VALIDATION_CASES: SearchQuery[] = [
  { libraryId: 'not-an-object-id' },
  { flag: 'maybe' },
  { color: 'chartreuse' },
  { pathPrefix: 'x'.repeat(1025) },
  { sceneType: 'underwater' },
  { ext: 'dng,../etc' },
  { ext: 'DNG' },
  { scope: 'albums' },
  { scope: 'nonsense' },
  // Wrong in two ways: both builders must pick the same one to report.
  { libraryId: 'bad', flag: 'maybe' },
  { flag: 'maybe', color: 'chartreuse' },
  { color: 'chartreuse', sceneType: 'underwater' },
  { sceneType: 'underwater', ext: '../etc' },
  { ext: '../etc', scope: 'nonsense' },
  // Accepted: an empty flag, an empty colour, an empty scope, a valid id.
  { flag: '' },
  { color: '' },
  { scope: '' },
  { flag: 'pick', color: 'blue', scope: 'photos' },
  {},
];

describe('validation parity with buildFilter', () => {
  for (const query of VALIDATION_CASES) {
    test(JSON.stringify(query), () => {
      const mongo = buildFilter(query);
      const sqlite = buildSearchWhere(query);
      const mongoError = 'error' in mongo ? mongo.error : null;
      const sqliteError = 'error' in sqlite ? sqlite.error : null;
      expect(sqliteError).toBe(mongoError);
    });
  }
});

describe('buildSearchWhere — the clause list', () => {
  test('an empty query adds only the always-on hidden filter', () => {
    const where = buildSearchWhere({});
    if ('error' in where) throw new Error(where.error);
    expect(where.clauses).toEqual(['assets.hidden = 0']);
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
    const clause = (hidden?: string): readonly string[] => {
      const where = buildSearchWhere(hidden === undefined ? {} : { hidden });
      if ('error' in where) throw new Error(where.error);
      return where.clauses;
    };
    expect(clause()).toEqual(['assets.hidden = 0']);
    expect(clause('none')).toEqual(['assets.hidden = 0']);
    expect(clause('all')).toEqual([]);
    expect(clause('only')).toEqual(['assets.hidden = 1']);
  });

  test('an out-of-range month is dropped rather than matching nothing', () => {
    // A filter that matches nothing is worse than no filter here: the
    // generated-search worker reads the result count as a quality signal.
    for (const month of ['0', '13', '6.5', 'june']) {
      const where = buildSearchWhere({ month });
      if ('error' in where) throw new Error(where.error);
      expect(where.clauses).toEqual(['assets.hidden = 0']);
    }
    const valid = buildSearchWhere({ month: '6' });
    if ('error' in valid) throw new Error(valid.error);
    expect(valid.clauses).toEqual(['assets.captured_month = ?', 'assets.hidden = 0']);
  });

  test('bare dates widen to the whole day, as the Mongo builder does', () => {
    const where = buildSearchWhere({ from: '2024-01-01', to: '2024-12-31' });
    if ('error' in where) throw new Error(where.error);
    expect(where.params).toEqual(['2024-01-01T00:00:00.000Z', '2024-12-31T23:59:59.999Z']);
  });
});
