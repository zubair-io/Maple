/**
 * A person's name, and the identity rules built on it (#3749).
 *
 * Split out of `people.repo.test.ts` because the name is where the repo's one
 * genuinely surprising rule lives: two people holding the same name is not a
 * state the system has, so naming a cluster something already taken merges the
 * two rather than failing. Everything here is an aspect of that — creating by
 * name is idempotent, renaming onto a taken name merges, and the search
 * layer's name lookups have to agree with both.
 *
 * "The same name" means the rule `people_name_unique` enforces, which is a
 * folded key rather than a collation — see `db/sqlite/case-fold.ts`. Several of
 * these cases fail under an ASCII-only fold, which is what the index used to
 * have.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';
import { createPerson, renamePerson } from './people.repo.ts';
import { namesForPersonIds, personIdsForNames } from './people.search-filter.ts';
import {
  insertFace,
  insertLibrary,
  insertLiveAsset,
  insertPerson,
  testDb,
} from './people.test-helpers.ts';

describe('createPerson', () => {
  test('creates a person and returns it with an id', async () => {
    using handle = await createTestDatabase();
    const db = testDb(handle.db);

    const person = await createPerson('Ada', db);

    expect(person.name).toBe('Ada');
    expect(person._id).toBeInstanceOf(ObjectId);
    expect(person.merged_into).toBeNull();
  });

  test('answers without the suggestion keys the Mongo document omits', async () => {
    using handle = await createTestDatabase();
    const db = testDb(handle.db);

    const person = await createPerson('Ada', db);

    // A just-created person has never been through a clustering pass, so the
    // Mongo document has no suggestion fields at all. JSON.stringify drops an
    // absent key and keeps an explicit null, so a client testing for presence
    // rather than value sees the difference.
    expect(Object.keys(JSON.parse(JSON.stringify(person)) as object).sort()).toEqual([
      '_id',
      'created_at',
      'merged_into',
      'name',
      'updated_at',
    ]);
  });

  test('is idempotent, case-insensitively', async () => {
    using handle = await createTestDatabase();
    const db = testDb(handle.db);

    const first = await createPerson('Ada', db);
    const second = await createPerson('ADA', db);

    // Typing a name that already exists is not an error — it selects.
    expect(second._id.toHexString()).toBe(first._id.toHexString());
    expect(second.name).toBe('Ada');
  });

  test('is idempotent for a name outside ASCII too', async () => {
    using handle = await createTestDatabase();
    const db = testDb(handle.db);

    const first = await createPerson('josé', db);
    const second = await createPerson('JOSÉ', db);

    // SQLite's NOCASE folds A-Z and stops there, so under it these are two
    // different names: the lookup misses, the unique index permits the row,
    // and the operator quietly ends up with two people. The Mongo collation
    // { locale: 'en', strength: 2 } this replaces treats them as one name.
    expect(second._id.toHexString()).toBe(first._id.toHexString());
    expect(second.name).toBe('josé');
    const count = handle.db.query('SELECT COUNT(*) AS n FROM people').get();
    expect(count).toEqual({ n: 1 });
  });

  test('trims, and refuses a blank name or one holding a comma', async () => {
    using handle = await createTestDatabase();
    const db = testDb(handle.db);

    expect((await createPerson('  Ada  ', db)).name).toBe('Ada');
    await expect(createPerson('   ', db)).rejects.toThrow('name must not be empty');
    // The search wire format is comma-separated, so a comma in a name would
    // split it into two filters.
    await expect(createPerson('Lovelace, Ada', db)).rejects.toThrow(
      'name must not contain a comma',
    );
  });

  test('a merged-away person does not hold its old name hostage', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const survivor = insertPerson(db, { name: 'Survivor' });
    insertPerson(db, { name: 'Ada', mergedInto: survivor });

    const created = await createPerson('Ada', testDb(db));

    expect(created.name).toBe('Ada');
    expect(created.merged_into).toBeNull();
  });
});

describe('renamePerson', () => {
  test('renames, and reports no merge', async () => {
    using handle = await createTestDatabase();
    const db = testDb(handle.db);
    const person = await createPerson('Ada', db);

    const result = await renamePerson(person._id, 'Ada Lovelace', db);

    expect(result.survivor.name).toBe('Ada Lovelace');
    expect(result.mergedFrom).toBeUndefined();
  });

  test('a case-only rename still rewrites the stored spelling', async () => {
    using handle = await createTestDatabase();
    const db = testDb(handle.db);
    const person = await createPerson('ada', db);

    const result = await renamePerson(person._id, 'Ada', db);
    const stored = handle.db
      .query('SELECT name FROM people WHERE id = ?')
      .get(person._id.toHexString());

    expect(result.survivor.name).toBe('Ada');
    expect(stored).toEqual({ name: 'Ada' });
  });

  test('renaming onto a live name merges, and the older id survives', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const library = insertLibrary(db);
    // Ids are minted in ascending order, so `older` is the lexicographically
    // smaller one and must win regardless of which side is renamed.
    const [olderId, newerId] = [new ObjectId(), new ObjectId()]
      .map((id) => id.toHexString())
      .sort();
    insertPerson(db, { id: olderId, name: 'Ada' });
    insertPerson(db, { id: newerId, name: 'Ada L' });
    const asset = insertLiveAsset(db, library);
    insertFace(db, { assetId: asset, personId: newerId });

    const result = await renamePerson(new ObjectId(newerId), 'Ada', testDb(db));

    expect(result.survivor._id.toHexString()).toBe(olderId);
    expect(result.mergedFrom?.toHexString()).toBe(newerId);
    // The orphan's face came with it.
    const face = db.query('SELECT person_id FROM faces WHERE asset_id = ?').get(asset);
    expect(face).toEqual({ person_id: olderId });
    const orphan = db.query('SELECT merged_into FROM people WHERE id = ?').get(newerId);
    expect(orphan).toEqual({ merged_into: olderId });
  });

  test('renaming onto an accented duplicate merges, like any other duplicate', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const [olderId, newerId] = [new ObjectId(), new ObjectId()]
      .map((id) => id.toHexString())
      .sort();
    insertPerson(db, { id: olderId, name: 'josé' });
    insertPerson(db, { id: newerId, name: 'Unnamed' });

    const result = await renamePerson(new ObjectId(newerId), 'JOSÉ', testDb(db));

    // Naming two clusters the same thing is how an operator says they are the
    // same person. Under an ASCII-only fold this takes the plain-rename branch
    // instead and leaves two live people holding the same name.
    expect(result.mergedFrom?.toHexString()).toBe(newerId);
    expect(result.survivor._id.toHexString()).toBe(olderId);
  });

  test('refuses an unknown or already-merged person', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const missing = new ObjectId();
    const survivor = insertPerson(db, { name: 'Survivor' });
    const merged = insertPerson(db, { name: 'Gone', mergedInto: survivor });

    await expect(renamePerson(missing, 'Ada', testDb(db))).rejects.toThrow(
      `person not found: ${missing.toHexString()}`,
    );
    await expect(renamePerson(new ObjectId(merged), 'Ada', testDb(db))).rejects.toThrow(
      `person already merged: ${merged}`,
    );
  });
});

describe('the search layer’s name lookups', () => {
  test('personIdsForNames matches an accented name whatever case it arrives in', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const person = insertPerson(db, { name: 'Zoë' });

    const found = await personIdsForNames(['ZOË'], testDb(db));

    expect(found).toEqual([person]);
  });

  test('personIdsForNames matches case-insensitively and skips the hidden', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const ada = insertPerson(db, { name: 'Ada' });
    const excluded = insertPerson(db, { name: 'Excluded', excluded: true });
    insertPerson(db, { name: 'Hidden', hidden: true });
    const dbHandle = testDb(db);

    const found = await personIdsForNames(['ADA', 'Hidden', 'Excluded'], dbHandle);

    // Excluded people are matched here and dropped later, by `personIdsToDrop`.
    expect(found?.sort()).toEqual([ada, excluded].sort());
    // An empty name list means "no person constraint", not "match nobody".
    expect(await personIdsForNames([], dbHandle)).toBeNull();
  });

  test('namesForPersonIds leaves the auto-generated names out of the picker', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const ada = insertPerson(db, { name: 'Ada' });
    const auto = insertPerson(db, { name: 'Person 12' });
    const notAuto = insertPerson(db, { name: 'Person Alice' });
    const padded = insertPerson(db, { name: 'Person 007' });

    const names = await namesForPersonIds([ada, auto, notAuto, padded, 'nonsense'], testDb(db));

    expect(names.get(ada)).toBe('Ada');
    expect(names.has(auto)).toBe(false);
    // "Person 007" is digits to the end, so it is an auto-name too.
    expect(names.has(padded)).toBe(false);
    // "Person Alice" is somebody's actual name and must survive.
    expect(names.get(notAuto)).toBe('Person Alice');
  });
});
