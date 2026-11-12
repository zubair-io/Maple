/**
 * The discover sweep's RAW+JPEG pairing write (#5849) re-checks what it read: a file renamed
 * between the folder read and the pairing transaction is not paired by a stale stem match.
 * Real SQLite, through the process pool.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import { reconcileRawJpegStacks } from './assets.raw-jpeg-stacks.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import type { SqlParams } from '../sqlite/protocol.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let libraryId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  libraryId = insertFolder(live.db, { slug: 'stacks' });
});

afterEach(() => live.close());

function seed(filename: string): string {
  const id = insertAsset(live.db);
  insertLocation(live.db, { assetId: id, libraryId, path: 'trip', filename });
  return id;
}

function stackPrimaryOf(id: string): string | null {
  const row = live.db.query('SELECT stack_primary_id FROM assets WHERE id = ?').get(id) as {
    stack_primary_id: string | null;
  };
  return row.stack_primary_id;
}

/** The pool, with `between` run after the folder read answers and before anything is written. */
function racing(between: () => void): SqliteDb {
  const pool = sqliteDb();
  return {
    read: async <T>(sql: string, params?: SqlParams) => {
      const rows = await pool.read<T>(sql, params);
      between();
      return rows;
    },
    write: (sql, params) => pool.write(sql, params),
    transaction: (statements) => pool.transaction(statements),
  };
}

describe('RAW+JPEG pairing write #5849', () => {
  test('a JPEG renamed after the folder read is not paired under its old stem', async () => {
    const raw = seed('IMG_1.CR3');
    const jpeg = seed('IMG_1.JPG');
    const rename = () =>
      run(live.db, 'UPDATE asset_locations SET filename = ? WHERE asset_id = ?', 'IMG_2.JPG', jpeg);

    await reconcileRawJpegStacks(new ObjectId(libraryId), 'trip', racing(rename));

    expect(stackPrimaryOf(jpeg)).toBeNull();
    expect(stackPrimaryOf(raw)).toBeNull();
  });

  test('a RAW renamed after the folder read does not take the JPEG with it', async () => {
    const raw = seed('IMG_1.CR3');
    const jpeg = seed('IMG_1.JPG');
    const rename = () =>
      run(live.db, 'UPDATE asset_locations SET filename = ? WHERE asset_id = ?', 'IMG_9.CR3', raw);

    await reconcileRawJpegStacks(new ObjectId(libraryId), 'trip', racing(rename));

    expect(stackPrimaryOf(jpeg)).toBeNull();
  });

  test('an undisturbed folder still pairs', async () => {
    const raw = seed('IMG_1.CR3');
    const jpeg = seed('IMG_1.JPG');

    await reconcileRawJpegStacks(
      new ObjectId(libraryId),
      'trip',
      racing(() => {}),
    );

    expect(stackPrimaryOf(jpeg)).toBe(raw);
  });
});
