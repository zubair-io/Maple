/**
 * `indexer_checkpoints` behaviour, with the set semantics of the in-flight
 * list as the main event.
 *
 * `$addToSet` is the operator a JSON array column does not get for free, and
 * getting it wrong is not cosmetic: a duplicated id means a resume re-enqueues
 * the same job twice. The other case worth pinning is the marker creating a
 * row before any walk has recorded a path, which is what the DDL's defaults
 * are for.
 */

import { describe, expect, test } from 'bun:test';
import { createTestDatabase, testSqliteDb } from '../test-sqlite.test-helpers.ts';
import { newObjectIdHex } from '../object-id.ts';
import {
  clearInflight,
  markInflight,
  readCheckpoint,
  writeCheckpoint,
} from './indexer-checkpoints.repo.ts';

describe('readCheckpoint', () => {
  test('returns null for a library that has never been walked', async () => {
    using handle = await createTestDatabase();
    expect(await readCheckpoint(newObjectIdHex(), testSqliteDb(handle.db))).toBeNull();
  });
});

describe('writeCheckpoint', () => {
  test('creates the row and reads back every field', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = newObjectIdHex();
    await writeCheckpoint(
      {
        folderId,
        path: '/libraries/photos',
        lastWalkedAt: 1_700_000_000_000,
        inflightIds: ['aaaa', 'bbbb'],
        sweepGen: 3,
        updatedAt: 0,
      },
      db,
    );
    const doc = await readCheckpoint(folderId, db);
    expect(doc?.path).toBe('/libraries/photos');
    expect(doc?.lastWalkedAt).toBe(1_700_000_000_000);
    expect(doc?.inflightIds).toEqual(['aaaa', 'bbbb']);
    expect(doc?.sweepGen).toBe(3);
  });

  test('stamps its own updatedAt rather than trusting the caller', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = newObjectIdHex();
    const before = Date.now();
    await writeCheckpoint(
      { folderId, path: '/a', lastWalkedAt: 1, inflightIds: [], updatedAt: 0 },
      db,
    );
    expect((await readCheckpoint(folderId, db))?.updatedAt).toBeGreaterThanOrEqual(before);
  });

  test('a document with no sweep generation reads back without the key', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = newObjectIdHex();
    await writeCheckpoint(
      { folderId, path: '/a', lastWalkedAt: 1, inflightIds: [], updatedAt: 0 },
      db,
    );
    const doc = await readCheckpoint(folderId, db);
    expect(Object.keys(doc ?? {})).not.toContain('sweepGen');
  });

  test('a later walk overwrites the earlier one', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = newObjectIdHex();
    await writeCheckpoint(
      { folderId, path: '/a', lastWalkedAt: 1, inflightIds: ['x'], sweepGen: 1, updatedAt: 0 },
      db,
    );
    await writeCheckpoint(
      { folderId, path: '/a', lastWalkedAt: 2, inflightIds: [], sweepGen: 2, updatedAt: 0 },
      db,
    );
    const doc = await readCheckpoint(folderId, db);
    expect(doc?.lastWalkedAt).toBe(2);
    expect(doc?.sweepGen).toBe(2);
    expect(doc?.inflightIds).toEqual([]);
  });

  test('a walk that names no sweep generation leaves the stored one alone', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = newObjectIdHex();
    await writeCheckpoint(
      { folderId, path: '/a', lastWalkedAt: 1, inflightIds: [], sweepGen: 7, updatedAt: 0 },
      db,
    );
    // `sweepGen` is optional, so this is a legal document. On Mongo the key was
    // absent from the `$set` and generation 7 survived; `sweep_gen =
    // excluded.sweep_gen` would write NULL and restart the discover sweep from
    // generation 0.
    await writeCheckpoint(
      { folderId, path: '/a', lastWalkedAt: 2, inflightIds: [], updatedAt: 0 },
      db,
    );
    const doc = await readCheckpoint(folderId, db);
    expect(doc?.sweepGen).toBe(7);
    // The columns the document does name still move.
    expect(doc?.lastWalkedAt).toBe(2);
  });

  test('a later generation still overwrites an earlier one', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = newObjectIdHex();
    await writeCheckpoint(
      { folderId, path: '/a', lastWalkedAt: 1, inflightIds: [], sweepGen: 7, updatedAt: 0 },
      db,
    );
    await writeCheckpoint(
      { folderId, path: '/a', lastWalkedAt: 2, inflightIds: [], sweepGen: 8, updatedAt: 0 },
      db,
    );
    // COALESCE preserves an omitted generation; it must not swallow a named one.
    expect((await readCheckpoint(folderId, db))?.sweepGen).toBe(8);
  });
});

describe('markInflight', () => {
  test('creates the row before any walk has recorded a path', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = newObjectIdHex();
    await markInflight(folderId, 'job-1', db);
    const doc = await readCheckpoint(folderId, db);
    // The Mongo row simply had no `path` yet; the column's default is the
    // closest honest equivalent to an absent field.
    expect(doc?.path).toBe('');
    expect(doc?.lastWalkedAt).toBe(0);
    expect(doc?.inflightIds).toEqual(['job-1']);
  });

  test('appends in order', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = newObjectIdHex();
    await markInflight(folderId, 'job-1', db);
    await markInflight(folderId, 'job-2', db);
    await markInflight(folderId, 'job-3', db);
    expect((await readCheckpoint(folderId, db))?.inflightIds).toEqual(['job-1', 'job-2', 'job-3']);
  });

  test('marking the same job twice does not list it twice', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = newObjectIdHex();
    await markInflight(folderId, 'job-1', db);
    await markInflight(folderId, 'job-2', db);
    await markInflight(folderId, 'job-1', db);
    // $addToSet. A duplicate here means a resume enqueues the same job twice.
    expect((await readCheckpoint(folderId, db))?.inflightIds).toEqual(['job-1', 'job-2']);
  });

  test('adds to a list a completed walk already recorded', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = newObjectIdHex();
    await writeCheckpoint(
      { folderId, path: '/a', lastWalkedAt: 5, inflightIds: ['job-1'], updatedAt: 0 },
      db,
    );
    await markInflight(folderId, 'job-2', db);
    const doc = await readCheckpoint(folderId, db);
    expect(doc?.inflightIds).toEqual(['job-1', 'job-2']);
    // The marker names neither, so the walk it found is left intact.
    expect(doc?.path).toBe('/a');
    expect(doc?.lastWalkedAt).toBe(5);
  });
});

describe('clearInflight', () => {
  test('removes just the job that finished', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = newObjectIdHex();
    await markInflight(folderId, 'job-1', db);
    await markInflight(folderId, 'job-2', db);
    await clearInflight(folderId, 'job-1', db);
    expect((await readCheckpoint(folderId, db))?.inflightIds).toEqual(['job-2']);
  });

  test('empties the list down to an array, not to null', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = newObjectIdHex();
    await markInflight(folderId, 'job-1', db);
    await clearInflight(folderId, 'job-1', db);
    expect((await readCheckpoint(folderId, db))?.inflightIds).toEqual([]);
  });

  test('clearing a job that is not listed changes nothing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = newObjectIdHex();
    await markInflight(folderId, 'job-1', db);
    await clearInflight(folderId, 'job-9', db);
    expect((await readCheckpoint(folderId, db))?.inflightIds).toEqual(['job-1']);
  });

  test('is a no-op on a library with no checkpoint', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = newObjectIdHex();
    await clearInflight(folderId, 'job-1', db);
    // No upsert: there is nothing to record about a job finishing on a
    // library that was never checkpointed.
    expect(await readCheckpoint(folderId, db)).toBeNull();
  });
});
