/**
 * The request gate in front of an image capability.
 *
 * What this module owns is the decision to look at all: GET only, one of two
 * route families, and a token of exactly the shape the issuer mints. Whether a
 * given token is live for a given path belongs to
 * `db/repos/auth.image-capability.repo.ts` and is tested there, so the
 * cases below are about the gate and about the one path through it that
 * reaches storage.
 */

import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { verifyImageCapability } from './image-capability.ts';
import { issueImageCapability } from '../db/repos/auth.image-capability.repo.ts';
import type { SqliteDb } from '../db/repos/db-handle.ts';
import { createTestDatabase, testSqliteDb } from '../db/sqlite/test-sqlite.test-helpers.ts';

const PATH = '/api/thumb/photos/a.jpg';

/** A handle that refuses to be used, and counts the attempts. */
function countingDb(): { db: SqliteDb; reads: () => number } {
  let reads = 0;
  const db: SqliteDb = {
    read: async <T>() => {
      reads += 1;
      return [] as T[];
    },
    write: async () => {
      reads += 1;
      return { changes: 0, lastInsertRowid: 0 };
    },
    transaction: async () => {
      reads += 1;
      return [];
    },
  };
  return { db, reads: () => reads };
}

describe('image URL capabilities', () => {
  test('a token that is not a 32-byte base64url value never reaches the database', async () => {
    const { db, reads } = countingDb();

    for (const token of ['a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}+`]) {
      expect(
        await verifyImageCapability(new Request(`http://maple${PATH}?token=${token}`), db),
      ).toBe(false);
    }
    expect(reads()).toBe(0);
  });

  test('a request that is not a GET on an image route never reaches the database', async () => {
    const { db, reads } = countingDb();
    const token = randomBytes(32).toString('base64url');

    // Right shape, wrong method.
    expect(
      await verifyImageCapability(
        new Request(`http://maple${PATH}?token=${token}`, { method: 'POST' }),
        db,
      ),
    ).toBe(false);
    // Right shape and method, but a route family capabilities do not cover.
    expect(
      await verifyImageCapability(new Request(`http://maple/api/assets?token=${token}`), db),
    ).toBe(false);
    expect(reads()).toBe(0);
  });

  test('a live grant authorises its own path and no other', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const token = randomBytes(32).toString('base64url');
    await issueImageCapability(token, PATH, new Date(Date.now() + 60_000), db);

    expect(await verifyImageCapability(new Request(`http://maple${PATH}?token=${token}`), db)).toBe(
      true,
    );
    // The same token on the preview of the same photo is a different grant.
    expect(
      await verifyImageCapability(
        new Request(`http://maple/api/preview/photos/a.jpg?token=${token}`),
        db,
      ),
    ).toBe(false);
  });
});
