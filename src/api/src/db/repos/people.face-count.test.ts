/**
 * Per-person face counts, derived rather than maintained (#3749).
 *
 * The ticket's third exit criterion. The interesting assertions are the ones
 * about what is *absent*: there is no `face_count` column, and no write path
 * adjusts one. Every count in this file is produced by counting rows, so the
 * drift the Mongo version needs a per-pass self-heal to repair cannot occur.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ObjectId } from '../object-id.ts';
import {
  createTestDatabase,
  insertAsset,
  insertLocation,
  run,
} from '../sqlite/test-sqlite.test-helpers.ts';
import type { SqlValue } from '../sqlite/migrate.ts';
import { faceCountByPerson, recomputePersonFaceCount } from './people.face-count.ts';
import { faceCountsForPeopleSql, FACE_COUNTS_BY_PERSON_SQL } from './people.sql.ts';
import { listPeople, assignFaceToPerson, hideFace } from './people.repo.ts';
import { mergePeopleInto } from './people.merge.ts';
import {
  insertFace,
  insertLibrary,
  insertLiveAsset,
  insertPerson,
  testDb,
} from './people.test-helpers.ts';

describe('the schema has no counter to maintain', () => {
  test('people has no face_count column', async () => {
    using handle = await createTestDatabase();
    const columns = handle.db.query('PRAGMA table_info(people)').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);

    // `centroid_face_count` is a different field — clustering's staleness
    // marker, not a count of anything a reader displays — and it stays.
    expect(names).toContain('centroid_face_count');
    expect(names).not.toContain('face_count');
  });
});

describe('faceCountByPerson', () => {
  test('counts the live, unhidden, assigned faces of each person', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    const grace = insertPerson(db, { name: 'Grace' });

    const first = insertLiveAsset(db, library);
    const second = insertLiveAsset(db, library);
    insertFace(db, { assetId: first, faceIndex: 0, personId: ada });
    insertFace(db, { assetId: first, faceIndex: 1, personId: grace });
    insertFace(db, { assetId: second, faceIndex: 0, personId: ada });

    const counts = await faceCountByPerson(undefined, testDb(db));

    expect(counts.get(ada)).toBe(2);
    expect(counts.get(grace)).toBe(1);
  });

  test('a person with no faces is absent rather than zero', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const lonely = insertPerson(db, { name: 'Nobody' });

    const counts = await faceCountByPerson(undefined, testDb(db));

    // Every caller reads this through `?? 0`, which is the same contract the
    // Mongo aggregation has: it emits no group for a person with no rows.
    expect(counts.has(lonely)).toBe(false);
    expect(counts.get(lonely) ?? 0).toBe(0);
  });

  test('hidden faces, dead assets and missing files are all excluded', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });

    const counted = insertLiveAsset(db, library);
    insertFace(db, { assetId: counted, personId: ada });

    // Hidden face on a live asset.
    const hiddenFace = insertLiveAsset(db, library);
    insertFace(db, { assetId: hiddenFace, personId: ada, hidden: true });

    // Soft-deleted asset.
    const trashed = insertAsset(db, { deletedAt: new Date().toISOString() });
    insertLocation(db, { assetId: trashed, libraryId: library });
    insertFace(db, { assetId: trashed, personId: ada });

    // Live asset whose only file has gone missing from disk.
    const gone = insertAsset(db);
    insertLocation(db, { assetId: gone, libraryId: library, missingSince: 'yesterday' });
    insertFace(db, { assetId: gone, personId: ada });

    const counts = await faceCountByPerson(undefined, testDb(db));

    expect(counts.get(ada)).toBe(1);
  });

  test('naming the people answers for exactly them, with the same numbers', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    const grace = insertPerson(db, { name: 'Grace' });

    const first = insertLiveAsset(db, library);
    const second = insertLiveAsset(db, library);
    insertFace(db, { assetId: first, faceIndex: 0, personId: ada });
    insertFace(db, { assetId: first, faceIndex: 1, personId: grace });
    insertFace(db, { assetId: second, faceIndex: 0, personId: ada });

    const scoped = await faceCountByPerson([ada], testDb(db));

    expect(scoped.get(ada)).toBe(2);
    // Grace has faces, but the caller did not ask about her.
    expect(scoped.has(grace)).toBe(false);
  });

  test('naming nobody asks nothing of the database', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    insertFace(db, { assetId: insertLiveAsset(db, library), personId: ada });

    expect((await faceCountByPerson([], testDb(db))).size).toBe(0);
  });
});

/**
 * The cost of deriving the count is a claim about which index answers it, and
 * a timing over a handful of test rows cannot check that. These two plans are
 * what keep the count off the "walk the whole face table and read an asset row
 * per face" path the review of #3767 flagged.
 */
describe('the face count is answered by indexes, not by scans', () => {
  function plan(db: Database, sql: string, ...params: SqlValue[]): string {
    const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
    return rows.map((row) => row.detail).join('\n');
  }

  test('the whole-library count probes liveness from an index, not from the row', async () => {
    using handle = await createTestDatabase();
    const detail = plan(handle.db, FACE_COUNTS_BY_PERSON_SQL);

    // Walking every assigned face is the point of this form, and it is
    // index-only: `faces_person` already carries person_id and asset_id.
    expect(detail).toContain('COVERING INDEX faces_person');
    // The liveness probe is the part that used to read a whole asset row per
    // face. 591 ms -> 175 ms on a 335k-asset library.
    expect(detail).toContain('assets_live_id');
  });

  test('naming the people turns the walk into a seek each', async () => {
    using handle = await createTestDatabase();
    const detail = plan(handle.db, faceCountsForPeopleSql(2), 'a', 'b');

    expect(detail).toContain('COVERING INDEX faces_person (person_id=?)');
    expect(detail).toContain('assets_live_id');
    expect(detail).not.toContain('SCAN faces');
  });
});

describe('recomputePersonFaceCount', () => {
  test('returns the count and writes nothing', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, personId: ada });
    const before = handle.db.query('SELECT updated_at FROM people WHERE id = ?').get(ada);

    const count = await recomputePersonFaceCount(ada, testDb(db));
    const after = handle.db.query('SELECT updated_at FROM people WHERE id = ?').get(ada);

    expect(count).toBe(1);
    // The Mongo version's whole job was the write; here the name survives only
    // because a route still calls it, and there is nothing left to write.
    expect(after).toEqual(before);
  });

  test('a malformed id answers zero rather than throwing', async () => {
    using handle = await createTestDatabase();

    expect(await recomputePersonFaceCount('not-an-object-id', testDb(handle.db))).toBe(0);
  });
});

describe('the count follows the rows with nothing maintaining it', () => {
  test('hiding a face lowers the count', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    const first = insertLiveAsset(db, library);
    const second = insertLiveAsset(db, library);
    insertFace(db, { assetId: first, personId: ada });
    insertFace(db, { assetId: second, personId: ada });
    const handleDb = testDb(db);

    const before = (await faceCountByPerson(undefined, handleDb)).get(ada);
    await hideFace(new ObjectId(first), 0, handleDb);
    const after = (await faceCountByPerson(undefined, handleDb)).get(ada);

    expect(before).toBe(2);
    expect(after).toBe(1);
  });

  test('moving a face moves the count with it', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    const grace = insertPerson(db, { name: 'Grace' });
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, personId: ada });
    const handleDb = testDb(db);

    await assignFaceToPerson(new ObjectId(asset), 0, new ObjectId(grace), handleDb);
    const counts = await faceCountByPerson(undefined, handleDb);

    expect(counts.has(ada)).toBe(false);
    expect(counts.get(grace)).toBe(1);
  });

  test('a merge hands the survivor the orphan’s faces without a recount step', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    const duplicate = insertPerson(db, { name: 'Ada Lovelace' });
    for (const _ of [0, 1]) {
      insertFace(db, { assetId: insertLiveAsset(db, library), personId: ada });
    }
    for (const _ of [0, 1, 2]) {
      insertFace(db, { assetId: insertLiveAsset(db, library), personId: duplicate });
    }
    const handleDb = testDb(db);

    await mergePeopleInto(new ObjectId(ada), [new ObjectId(duplicate)], handleDb);
    const counts = await faceCountByPerson(undefined, handleDb);

    // Repointing the rows is the update. On Mongo this is where the survivor's
    // stored counter has to be recomputed from ground truth and the orphan's
    // forced to zero.
    expect(counts.get(ada)).toBe(5);
    expect(counts.has(duplicate)).toBe(false);
  });

  test('the people listing reports the derived count', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    insertPerson(db, { name: 'Nobody' });
    insertFace(db, { assetId: insertLiveAsset(db, library), personId: ada });
    insertFace(db, { assetId: insertLiveAsset(db, library), personId: ada });

    const listed = await listPeople({}, testDb(db));

    expect(listed.map((row) => [row.person.name, row.faceCount])).toEqual([
      ['Ada', 2],
      ['Nobody', 0],
    ]);
  });

  test('withCounts: false skips the count query and reports zero', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    insertFace(db, { assetId: insertLiveAsset(db, library), personId: ada });

    const listed = await listPeople({ withCounts: false }, testDb(db));

    expect(listed[0]?.faceCount).toBe(0);
  });
});

describe('a face row cannot outlive the person it points at', () => {
  test('deleting a person nulls its faces rather than orphaning them', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    const ada = insertPerson(db, { name: 'Ada' });
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, personId: ada });

    run(db, 'DELETE FROM people WHERE id = ?', ada);
    const counts = await faceCountByPerson(undefined, testDb(db));
    const face = db.query('SELECT person_id FROM faces WHERE asset_id = ?').get(asset);

    // `ON DELETE SET NULL` only fires with the foreign-keys pragma on, which the
    // test harness applies for exactly this reason.
    expect(face).toEqual({ person_id: null });
    expect(counts.size).toBe(0);
  });
});
