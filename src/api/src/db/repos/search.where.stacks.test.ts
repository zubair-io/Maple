/**
 * The RAW+JPEG fold re-reads every filter clause against the stack's RAW by renaming the
 * request's row from `assets.` to `stack_raw.` (#5849). That is only sound while no clause opens
 * a table of its own named `assets`; this holds every clause builder to it.
 */

import { describe, expect, it } from 'bun:test';
import { buildSearchWhere, searchWhereSql, type SearchWhere } from './search.where.ts';
import type { SearchQuery } from '../../routes/search/query.ts';

const EVERY_FILTER: SearchQuery = {
  q: 'IMG',
  libraryId: '507f1f77bcf86cd799439011',
  camera: 'Canon',
  lens: '50mm',
  isoMin: '100',
  isoMax: '800',
  apertureMin: '1.4',
  apertureMax: '8',
  focalMin: '24',
  focalMax: '135',
  from: '2024-01-01',
  to: '2024-12-31',
  month: '6',
  rating: '3',
  flag: 'pick',
  color: 'red',
  pathPrefix: 'trip',
  hasCapturedAt: 'true',
  sceneType: 'outdoor',
  activity: 'hiking',
  subjects: 'dog,cat',
  isScreenshot: 'false',
  place: 'Portland, OR',
  scope: 'people',
  owner: '664000000000000000000001',
  stack: '1',
};

function built(query: SearchQuery, people: readonly string[] = []): SearchWhere {
  const where = buildSearchWhere(query, people, people.length > 0 ? people : null);
  if ('error' in where) throw new Error(where.error);
  return where;
}

describe('RAW+JPEG fold predicate #5849', () => {
  it('no clause opens a table named assets, so each can be re-read on the RAW', () => {
    const where = built(EVERY_FILTER, ['person-1']);
    expect(where.clauses.length).toBeGreaterThan(20);
    for (const clause of where.clauses) {
      expect(clause).not.toMatch(/\b(FROM|JOIN)\s+assets\b/i);
    }
  });

  it('a filtered fold binds every clause twice, once on the RAW', () => {
    const where = built(EVERY_FILTER, ['person-1']);
    const sql = searchWhereSql(where);
    expect(sql.sql).toContain('NOT EXISTS (SELECT 1 FROM assets AS stack_raw');
    expect(sql.params).toEqual([...where.params, ...where.params]);
    expect((sql.sql.match(/\?/g) ?? []).length).toBe(sql.params.length);
  });

  it('an unfiltered fold is the bare pointer residual; no stack=1 or an ext filter is no fold', () => {
    expect(searchWhereSql(built({ stack: '1' })).sql).toContain('+assets.stack_primary_id IS NULL');
    expect(searchWhereSql(built({ stack: '1' })).sql).not.toContain('stack_raw');
    expect(searchWhereSql(built({})).sql).not.toContain('stack_primary_id');
    expect(searchWhereSql(built({ stack: '1', ext: 'jpg' })).sql).not.toContain('stack_primary_id');
  });
});
