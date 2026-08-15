/**
 * #2864 — integration coverage for the unified-search People/Places model:
 * the two new facet buckets (`people`, `places`) and the structured
 * `people` / `place` filters on the Mongo list path.
 *
 * Seeds real assets + person rows: names must resolve to person ids
 * (`personIdsForNames`), hidden persons must vanish from the picker AND
 * from name resolution, duplicate faces of one person on one asset must
 * count once, and place labels must round-trip facets → filter.
 *
 * Real Mongo required (localhost:27017 by default, override via
 * `MAPLE_MONGO_URI`) — soft-skips when unreachable, matching
 * `list.test.ts`.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId, type Db } from 'mongodb';
import { facetsRoute } from './facets.ts';
import { listRoute } from './list.ts';
import { closeDb, getDb, isDbConnected } from '../../db/client.ts';

// Own database + explicit close (the repo-wide suite convention, #2783).
const TEST_DB = `maple_test_search_facets_pp_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

let db: Db | null = null;
let mongoReachable = false;

const PRIYA = new ObjectId();
const HIDDEN_PERSON = new ObjectId();

function asset(
  mapleId: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    maple_id: mapleId,
    fileinfo: [
      { path: '', filename: `${mapleId}.dng`, library_id: new ObjectId(), deleted_at: null },
    ],
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: 'now',
    deleted_at: null,
    hidden: false,
    exif: { captured_at: '2026-05-10T00:00:00.000Z' },
    ...extra,
  };
}

async function seed(d: Db): Promise<void> {
  await d.collection('people').insertMany([
    { _id: PRIYA, name: 'Priya Patel', created_at: 'now', updated_at: 'now', merged_into: null },
    {
      _id: HIDDEN_PERSON,
      name: 'Hidden Person',
      created_at: 'now',
      updated_at: 'now',
      merged_into: null,
      hidden: true,
    },
  ] as never);
  await d.collection('assets').insertMany([
    asset('a-portland', {
      faces: [{ person_id: PRIYA.toHexString() }],
      place: { rollups: { locality: 'Portland', region: 'OR', country_code: 'us' } },
    }),
    asset('a-kyoto', {
      // Two detections of the same person on one asset — must count once.
      faces: [{ person_id: PRIYA.toHexString() }, { person_id: PRIYA.toHexString() }],
      place: { rollups: { locality: 'Kyoto', region: null, country_code: 'jp' } },
    }),
    asset('a-hiddenperson', {
      faces: [{ person_id: HIDDEN_PERSON.toHexString() }],
      place: null,
    }),
  ] as never);
}

beforeEach(async () => {
  try {
    db = await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
    return;
  }
  if (!mongoReachable || !db) return;
  await db.collection('assets').deleteMany({});
  await db.collection('people').deleteMany({});
  await seed(db);
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  await closeDb();
});

describe('GET /api/search/facets — people & places buckets (#2864)', () => {
  it('lists named, visible persons with per-asset counts (dup faces count once)', async () => {
    if (!mongoReachable || !db) return;
    const app = new Elysia().use(facetsRoute);
    const res = await app.handle(new Request('http://localhost/facets'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.people).toEqual([{ value: 'Priya Patel', count: 2 }]);
  });

  it('labels place buckets as "locality, region" / bare locality', async () => {
    if (!mongoReachable || !db) return;
    const app = new Elysia().use(facetsRoute);
    const res = await app.handle(new Request('http://localhost/facets'));
    const body = await res.json();
    const values = (body.places as Array<{ value: string; count: number }>).map((p) => p.value);
    expect(values.sort()).toEqual(['Kyoto', 'Portland, OR']);
  });

  it('facet counts honour an active person filter (list/facets agreement)', async () => {
    if (!mongoReachable || !db) return;
    const app = new Elysia().use(facetsRoute);
    const res = await app.handle(
      new Request(`http://localhost/facets?people=${encodeURIComponent('Priya Patel')}`),
    );
    const body = await res.json();
    expect(body.total).toBe(2);
  });
});

describe('GET /api/search — structured people/place filters (#2864)', () => {
  const app = () => new Elysia().use(listRoute);

  it('people=<name> narrows to that person’s assets on the Mongo path', async () => {
    if (!mongoReachable || !db) return;
    const res = await app().handle(
      new Request(`http://localhost/?people=${encodeURIComponent('Priya Patel')}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.map((r: { filename: string }) => r.filename).sort()).toEqual([
      'a-kyoto.dng',
      'a-portland.dng',
    ]);
  });

  it('a hidden person’s name resolves to nothing — matches NO assets', async () => {
    if (!mongoReachable || !db) return;
    const res = await app().handle(
      new Request(`http://localhost/?people=${encodeURIComponent('Hidden Person')}`),
    );
    const body = await res.json();
    expect(body.total).toBe(0);
    expect(body.results).toEqual([]);
  });

  it('place labels from the facets round-trip as filters, OR across selections', async () => {
    if (!mongoReachable || !db) return;
    const one = await app().handle(
      new Request(`http://localhost/?place=${encodeURIComponent('Portland, OR')}`),
    );
    const oneBody = await one.json();
    expect(oneBody.results.map((r: { filename: string }) => r.filename)).toEqual([
      'a-portland.dng',
    ]);

    const both = await app().handle(
      new Request(`http://localhost/?place=${encodeURIComponent('Portland, OR|Kyoto')}`),
    );
    const bothBody = await both.json();
    expect(bothBody.results.map((r: { filename: string }) => r.filename).sort()).toEqual([
      'a-kyoto.dng',
      'a-portland.dng',
    ]);
  });

  it('people + place AND together', async () => {
    if (!mongoReachable || !db) return;
    const res = await app().handle(
      new Request(
        `http://localhost/?people=${encodeURIComponent('Priya Patel')}&place=${encodeURIComponent('Kyoto')}`,
      ),
    );
    const body = await res.json();
    expect(body.results.map((r: { filename: string }) => r.filename)).toEqual(['a-kyoto.dng']);
  });
});
