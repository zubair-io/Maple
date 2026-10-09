/**
 * #4443 — the two people lookups behind a search's scope run together, and
 * only the ones the request needs: no name lookup without a `people` filter,
 * no hidden-people read without the opt-in, excluded people dropped always.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { resolvePeopleIds, resolveSearchScope } from './scope.ts';
import type { SearchQuery } from './query.ts';
import { setSqliteHandleForTests, type SqliteHandle } from '../../db/sqlite/index.ts';
import { insertPerson } from '../../db/repos/people.test-helpers.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let reads: string[];
let inFlight: number;
let mostInFlight: number;

/** The live handle, with every read held until the next tick so concurrent
 * reads are observed overlapping and sequential ones are not. */
function observed(handle: SqliteHandle): SqliteHandle {
  return {
    ...handle,
    async read(sql, params) {
      reads.push(sql.replace(/\s+/gu, ' ').trim());
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await Bun.sleep(1);
      inFlight -= 1;
      return handle.read(sql, params);
    },
  };
}

beforeEach(async () => {
  live = await createLiveTestDatabase();
  reads = [];
  inFlight = 0;
  mostInFlight = 0;
  setSqliteHandleForTests(observed(live.handle));
});

afterEach(() => {
  live.close();
});

const query = (fields: Partial<SearchQuery>): SearchQuery => fields as SearchQuery;

describe('resolvePeopleIds', () => {
  it('runs the drop lookup and the name lookup at the same time', async () => {
    const ada = insertPerson(live.db, { name: 'Ada' });
    const hidden = insertPerson(live.db, { name: 'Hidden', hidden: true });
    const excluded = insertPerson(live.db, { name: 'Gone', excluded: true });

    const ids = await resolvePeopleIds(query({ people: 'Ada', excludeHiddenPeople: 'true' }));

    expect(ids.peopleIds).toEqual([ada]);
    expect(ids.dropIds.sort()).toEqual([excluded, hidden].sort());
    expect(reads).toHaveLength(3);
    expect(mostInFlight).toBe(3);
  });

  it('issues no name lookup when the request has no people filter', async () => {
    insertPerson(live.db, { name: 'Ada' });

    const ids = await resolvePeopleIds(query({}));

    expect(ids.peopleIds).toBeNull();
    expect(reads).toEqual(['SELECT id FROM people WHERE excluded = 1']);
  });

  it('reads hidden people only when the request opted in, excluded people always', async () => {
    const hidden = insertPerson(live.db, { name: 'Hidden', hidden: true });
    const excluded = insertPerson(live.db, { name: 'Gone', excluded: true });

    const optedOut = await resolvePeopleIds(query({ excludeHiddenPeople: 'false' }));
    expect(optedOut.dropIds).toEqual([excluded]);
    expect(reads.some((sql) => sql.includes('hidden = 1'))).toBe(false);

    const optedIn = await resolvePeopleIds(query({ excludeHiddenPeople: 'true' }));
    expect(optedIn.dropIds.sort()).toEqual([excluded, hidden].sort());
  });
});

describe('resolveSearchScope', () => {
  it('translates the query with both id sets applied', async () => {
    const ada = insertPerson(live.db, { name: 'Ada' });
    const excluded = insertPerson(live.db, { name: 'Gone', excluded: true });

    const where = await resolveSearchScope(query({ people: 'Ada' }));

    expect(where).not.toBeInstanceOf(Response);
    const serialised = JSON.stringify(where);
    expect(serialised).toContain(ada);
    expect(serialised).toContain(excluded);
  });
});
