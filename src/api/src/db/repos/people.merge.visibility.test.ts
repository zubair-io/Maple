/**
 * A merged person takes on the merge target's visibility (hidden / excluded flags).
 */

import type { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import { createTestDatabase } from '../sqlite/test-sqlite.test-helpers.ts';
import { mergeInto, mergePeopleInto } from './people.merge.ts';
import { renamePerson } from './people.repo.ts';
import {
  insertFace,
  insertLibrary,
  insertLiveAsset,
  insertPerson,
  testDb,
} from './people.test-helpers.ts';

describe('merged visibility follows the target', () => {
  const flagsOf = (db: Database, id: string) =>
    db.query('SELECT hidden, excluded FROM people WHERE id = ?').get(id);

  test.each([
    {
      targetFlags: {},
      sourceFlags: { excluded: true },
      expected: { hidden: 0, excluded: 0 },
    },
    {
      targetFlags: { excluded: true },
      sourceFlags: {},
      expected: { hidden: 0, excluded: 1 },
    },
    {
      targetFlags: { hidden: true },
      sourceFlags: { excluded: true },
      expected: { hidden: 1, excluded: 0 },
    },
  ])(
    'explicit merge keeps the target flags $expected',
    async ({ targetFlags, sourceFlags, expected }) => {
      using handle = await createTestDatabase();
      const db = handle.db;
      const library = insertLibrary(db);
      const target = insertPerson(db, { name: 'Ada', ...targetFlags });
      const source = insertPerson(db, { name: 'Ada L', ...sourceFlags });
      insertFace(db, {
        assetId: insertLiveAsset(db, library),
        personId: source,
      });

      await mergePeopleInto(new ObjectId(target), [new ObjectId(source)], testDb(db));

      expect(flagsOf(db, target)).toEqual(expected);
    },
  );

  test('renaming onto an existing name adopts that person’s flags even when the renamed person has the older id', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const older = insertPerson(db, {
      id: '1'.repeat(24),
      name: 'Alpha',
      excluded: true,
    });
    const holder = insertPerson(db, { id: '2'.repeat(24), name: 'Beta' });

    const result = await renamePerson(new ObjectId(older), 'Beta', testDb(db));

    expect(result.survivor._id.toHexString()).toBe(older);
    expect(flagsOf(db, older)).toEqual({ hidden: 0, excluded: 0 });
    expect(db.query('SELECT merged_into FROM people WHERE id = ?').get(holder)).toEqual({
      merged_into: older,
    });
  });

  test('renaming onto an excluded person excludes the survivor', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const older = insertPerson(db, { id: '1'.repeat(24), name: 'Alpha' });
    insertPerson(db, {
      id: '2'.repeat(24),
      name: 'Beta',
      hidden: true,
      excluded: true,
    });

    await renamePerson(new ObjectId(older), 'Beta', testDb(db));

    expect(flagsOf(db, older)).toEqual({ hidden: 1, excluded: 1 });
  });
});

describe('mergeInto visibilityFrom', () => {
  test('copies the named person’s flags onto the survivor', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const survivor = insertPerson(db, { name: 'A', excluded: true });
    const orphan = insertPerson(db, { name: 'B' });

    await mergeInto(
      new ObjectId(survivor),
      new ObjectId(orphan),
      'A',
      testDb(db),
      new ObjectId(orphan),
    );

    expect(db.query('SELECT hidden, excluded FROM people WHERE id = ?').get(survivor)).toEqual({
      hidden: 0,
      excluded: 0,
    });
  });

  test('renaming onto a name held by the older id keeps that holder’s flags', async () => {
    using handle = await createTestDatabase();
    const db = handle.db;
    const holder = insertPerson(db, {
      id: '1'.repeat(24),
      name: 'Beta',
      hidden: true,
    });
    const renamed = insertPerson(db, {
      id: '2'.repeat(24),
      name: 'Alpha',
      excluded: true,
    });

    await renamePerson(new ObjectId(renamed), 'Beta', testDb(db));

    expect(db.query('SELECT hidden, excluded FROM people WHERE id = ?').get(holder)).toEqual({
      hidden: 1,
      excluded: 0,
    });
  });
});
