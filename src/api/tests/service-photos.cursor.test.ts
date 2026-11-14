/**
 * A `query` search's cursor continues the ranking its first page came from, or is refused. The
 * in-process engine can come up or go down between pages, and the filters can resolve to other
 * photos; a cursor must never cut a later page from a differently ordered window.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { run } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { setInProcessSearchForTests } from '../src/search/search-pool.ts';
import { fakeInProcessSearch } from '../src/search/search.test-helpers.ts';
import {
  createServiceFixture,
  placeDoc,
  search,
  type ServiceFixture,
} from './helpers/service-photos-fixtures.ts';

const PARIS_FIELDS = {
  locality: 'Paris',
  region: 'Île-de-France',
  countryCode: 'fr',
  country: 'France',
};
const PARIS = placeDoc({ ...PARIS_FIELDS, displayName: 'Rue de Rivoli, Paris, France' });

let fx: ServiceFixture;
let photos: string[];

beforeEach(async () => {
  fx = await createServiceFixture();
  // Equal text matches, so the database ranks them by its own tie-break.
  photos = [1, 2, 3, 4].map((day) =>
    fx.photo({ capturedAt: `2024-07-0${day}T10:00:00.000Z`, searchBlob: 'lighthouse' }),
  );
});

afterEach(() => {
  setInProcessSearchForTests(null);
  fx.close();
});

/** The in-process engine, ranking the photos in the reverse of the database's order. */
function engineReversing(databaseOrder: readonly string[]) {
  setInProcessSearchForTests(
    fakeInProcessSearch([...databaseOrder].reverse().map((id) => `maple-${id}`)),
  );
}

async function page(body: Record<string, unknown>) {
  const result = await search(fx.key, { query: 'lighthouse', limit: 2, ...body });
  return { ...result, ids: (result.body.photos ?? []).map((photo) => photo.assetId) };
}

describe('query cursors', () => {
  it('keeps a database-ranked search on the database when the engine comes up', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));
    const everything = (await page({ limit: 4 })).ids;
    const first = await page({});
    engineReversing(everything);
    const second = await page({ cursor: first.body.nextCursor });
    expect(second.status).toBe(200);
    expect([...first.ids, ...second.ids]).toEqual(everything);
  });

  it('refuses to continue an engine-ranked search on the database', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));
    engineReversing((await page({ limit: 4 })).ids);
    const first = await page({});
    expect(first.status).toBe(200);
    setInProcessSearchForTests(fakeInProcessSearch(null));
    const second = await page({ cursor: first.body.nextCursor });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_cursor');
    expect(second.body.message).toContain('without a cursor');
  });

  it('refuses a cursor once the filters resolve to other photos', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));
    run(fx.live.db, 'UPDATE assets SET place = ? WHERE id = ?', JSON.stringify(PARIS), photos[0]!);
    run(fx.live.db, 'UPDATE assets SET place = ? WHERE id = ?', JSON.stringify(PARIS), photos[1]!);
    const first = await page({ place: 'paris', limit: 1 });
    expect(first.body.total).toBe(2);
    // A third photo is geocoded to a Paris address no earlier page's filters included.
    const elsewhere = placeDoc({ ...PARIS_FIELDS, displayName: 'Place de la Concorde, Paris' });
    run(
      fx.live.db,
      'UPDATE assets SET place = ? WHERE id = ?',
      JSON.stringify(elsewhere),
      photos[2]!,
    );
    const second = await page({ place: 'paris', limit: 1, cursor: first.body.nextCursor });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_cursor');
  });
});
