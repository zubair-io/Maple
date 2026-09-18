/**
 * #2864 — integration coverage for the unified-search People/Places model:
 * the two new facet buckets (`people`, `places`) and the structured
 * `people` / `place` filters on the database list path.
 *
 * Seeds real assets + person rows: names must resolve to person ids
 * (`personIdsForNames`), hidden persons must vanish from the picker AND
 * from name resolution, duplicate faces of one person on one asset must
 * count once, and place labels must round-trip facets → filter.
 *
 * Real SQLite, installed as the process-wide handle so both routes and the
 * people repository reach it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { facetsRoute } from './facets.ts';
import { listRoute } from './list.ts';
import { _resetCacheForTests } from './total-cache.ts';
import { insertFace, insertPerson } from '../../db/sqlite/repos/assets.test-helpers.ts';
import { seedSearchAsset } from '../../db/sqlite/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;

/**
 * Four people, chosen to pin the picker's exclusions.
 *
 * `Person 7` is a clustering placeholder the operator has not named and must
 * never reach the picker (#2879); `Person Alice` merely starts with the same
 * word and must survive, which is what makes the predicate anchored rather
 * than a `startsWith`.
 */
beforeEach(async () => {
  live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { slug: 'facets-pp', path: '/lib' });
  const priya = insertPerson(live.db, 'Priya Patel');
  const hiddenPerson = insertPerson(live.db, 'Hidden Person');
  run(live.db, `UPDATE people SET hidden = 1 WHERE id = ?`, hiddenPerson);
  const autoPerson = insertPerson(live.db, 'Person 7');
  const personAlice = insertPerson(live.db, 'Person Alice');

  const seed = (
    name: string,
    place: { locality: string | null; region: string | null; countryCode: string | null },
    faces: Array<{ personId: string; faceIndex: number }>,
  ): void => {
    const id = seedSearchAsset(live.db, libraryId, {
      filename: `${name}.dng`,
      capturedAt: '2026-05-10T00:00:00.000Z',
      ...place,
    });
    for (const face of faces) {
      insertFace(live.db, { assetId: id, faceIndex: face.faceIndex, personId: face.personId });
    }
  };

  seed('a-portland', { locality: 'Portland', region: 'OR', countryCode: 'us' }, [
    { personId: priya, faceIndex: 0 },
  ]);
  // Two detections of the same person on one asset — must count once. Region
  // '' (not null): the bare "Kyoto" label must still round-trip through the
  // filter, since blank halves cover both NULL and ''.
  seed('a-kyoto', { locality: 'Kyoto', region: '', countryCode: 'jp' }, [
    { personId: priya, faceIndex: 0 },
    { personId: priya, faceIndex: 1 },
  ]);
  seed('a-hiddenperson', { locality: null, region: null, countryCode: null }, [
    { personId: hiddenPerson, faceIndex: 0 },
  ]);
  seed('a-autoperson', { locality: null, region: null, countryCode: null }, [
    { personId: autoPerson, faceIndex: 0 },
    { personId: personAlice, faceIndex: 1 },
  ]);
  _resetCacheForTests();
});

afterEach(() => {
  live.close();
  _resetCacheForTests();
});

/** The `people` bucket's values, for assertions that only care about who
 * is listed rather than the counts. */
function peopleValues(body: unknown): string[] {
  const people = (body as { people: Array<{ value: string }> }).people;
  return people.map((p) => p.value);
}

async function facets(qs = ''): Promise<Record<string, unknown>> {
  const app = new Elysia().use(facetsRoute);
  const res = await app.handle(new Request(`http://localhost/facets${qs}`));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function listFilenames(qs: string): Promise<{ total: number; filenames: string[] }> {
  const app = new Elysia().use(listRoute);
  const res = await app.handle(new Request(`http://localhost/?${qs}`));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { total: number; results: Array<{ filename: string }> };
  return { total: body.total, filenames: body.results.map((r) => r.filename) };
}

describe('GET /api/search/facets — people & places buckets (#2864)', () => {
  it('lists named, visible persons with per-asset counts (dup faces count once)', async () => {
    const body = await facets();
    // Priya (2 assets) and the operator-named "Person Alice" (1). The
    // clustering placeholder and the hidden person are both absent.
    expect(body.people).toEqual([
      { value: 'Priya Patel', count: 2 },
      { value: 'Person Alice', count: 1 },
    ]);
  });

  it('omits clustering placeholders ("Person N") from the picker (#2879)', async () => {
    const values = peopleValues(await facets()).sort();
    // "Person 7" is a placeholder the operator hasn't named — it carries no
    // meaning as a filter row. "Person Alice" is a real name that merely
    // starts with the same word: the predicate is anchored, so it stays.
    expect(values).toEqual(['Person Alice', 'Priya Patel']);
  });

  it('labels place buckets as "locality, region" / bare locality', async () => {
    const body = await facets();
    const values = (body.places as Array<{ value: string; count: number }>).map((p) => p.value);
    expect(values.sort()).toEqual(['Kyoto', 'Portland, OR']);
  });

  it('facet counts honour an active person filter (list/facets agreement)', async () => {
    const body = await facets(`?people=${encodeURIComponent('Priya Patel')}`);
    expect(body.total).toBe(2);
  });
});

describe('GET /api/search — structured people/place filters (#2864)', () => {
  it('people=<name> narrows to that person’s assets', async () => {
    const { filenames } = await listFilenames(`people=${encodeURIComponent('Priya Patel')}`);
    expect(filenames.sort()).toEqual(['a-kyoto.dng', 'a-portland.dng']);
  });

  it('a hidden person’s name resolves to nothing — matches NO assets', async () => {
    const { total, filenames } = await listFilenames(
      `people=${encodeURIComponent('Hidden Person')}`,
    );
    expect(total).toBe(0);
    expect(filenames).toEqual([]);
  });

  it('place labels from the facets round-trip as filters, OR across selections', async () => {
    const one = await listFilenames(`place=${encodeURIComponent('Portland, OR')}`);
    expect(one.filenames).toEqual(['a-portland.dng']);

    const both = await listFilenames(`place=${encodeURIComponent('Portland, OR|Kyoto')}`);
    expect(both.filenames.sort()).toEqual(['a-kyoto.dng', 'a-portland.dng']);
  });

  it('people + place AND together', async () => {
    const { filenames } = await listFilenames(
      `people=${encodeURIComponent('Priya Patel')}&place=${encodeURIComponent('Kyoto')}`,
    );
    expect(filenames).toEqual(['a-kyoto.dng']);
  });
});
