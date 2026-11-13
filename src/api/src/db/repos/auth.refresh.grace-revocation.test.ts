/**
 * #4742: the grace re-mint and family revocation must not interleave.
 *
 * Before the fix the grace path read `family_revoked_at`, then looked for a
 * live sibling, then inserted — three statements. A logout landing just before
 * the insert left a live token in a family it had just revoked, and normal
 * rotation renewed it for the rest of its 90 days.
 */
import { describe, expect, test } from 'bun:test';
import type { ObjectId } from '../object-id.ts';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import { insertUser } from './auth.users.repo.ts';
import { issueRefreshToken, revokeFamily, rotateRefreshToken } from './auth.refresh.repo.ts';
import type { SqliteDb } from './db-handle.ts';

async function seedUser(db: SqliteDb): Promise<ObjectId> {
  return await insertUser(
    {
      email: 'owner@example.com',
      role: 'owner',
      created_at: new Date().toISOString(),
      last_seen_at: null,
    },
    db,
  );
}

async function liveInFamily(db: SqliteDb, familyId: ObjectId): Promise<number> {
  const rows = await db.read<{ id: string }>(
    `SELECT id FROM refresh_tokens WHERE family_id = ? AND revoked_at IS NULL`,
    [familyId.toHexString()],
  );
  return rows.length;
}

/** A handle that runs `beforeInsert` immediately ahead of the first plain
 * `INSERT INTO refresh_tokens` write — the instant a logout would have to
 * land to slip between the grace path's checks and its insert. */
function revokingBeforeFirstInsert(inner: SqliteDb, beforeInsert: () => Promise<void>): SqliteDb {
  let armed = true;
  return {
    ...inner,
    read: (sql, params) => inner.read(sql, params),
    transaction: (statements) => inner.transaction(statements),
    write: async (sql, params) => {
      if (armed && sql.trimStart().startsWith('INSERT INTO refresh_tokens')) {
        armed = false;
        await beforeInsert();
      }
      return await inner.write(sql, params);
    },
  } as SqliteDb;
}

describe('grace re-mint vs family revocation (#4742)', () => {
  test('a logout landing just before the re-mint leaves the family fully revoked', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const first = await issueRefreshToken(userId, 'Laptop', {}, db);
    await rotateRefreshToken(first.raw, db);

    const racing = revokingBeforeFirstInsert(db, () => revokeFamily(first.familyId, db));
    await expect(rotateRefreshToken(first.raw, racing)).rejects.toMatchObject({
      code: 'reuse_detected',
    });
    expect(await liveInFamily(db, first.familyId)).toBe(0);
  });

  test('a live straggler inside a revoked family cannot rotate', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const first = await issueRefreshToken(userId, 'Laptop', {}, db);
    const straggler = await rotateRefreshToken(first.raw, db);
    // The state the old race left behind: the family carries a revocation
    // stamp, but one member minted after it is still live.
    await db.write(
      `UPDATE refresh_tokens SET family_revoked_at = ? WHERE family_id = ? AND revoked_at IS NOT NULL`,
      [new Date().toISOString(), first.familyId.toHexString()],
    );

    await expect(rotateRefreshToken(straggler.raw, db)).rejects.toMatchObject({
      code: 'reuse_detected',
    });
    expect(await liveInFamily(db, first.familyId)).toBe(0);
  });

  test('a benign replay inside the grace window still re-mints in the family', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const first = await issueRefreshToken(userId, 'Laptop', {}, db);
    await rotateRefreshToken(first.raw, db);

    const retry = await rotateRefreshToken(first.raw, db);
    expect(retry.familyId.toHexString()).toBe(first.familyId.toHexString());
    expect(await liveInFamily(db, first.familyId)).toBe(2);
    expect((await rotateRefreshToken(retry.raw, db)).raw).toBeDefined();
  });

  test('a replay whose family has no live member is a rotation conflict, not a re-mint', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const first = await issueRefreshToken(userId, 'Laptop', {}, db);
    await rotateRefreshToken(first.raw, db);
    await db.write(`UPDATE refresh_tokens SET revoked_at = ? WHERE revoked_at IS NULL`, [
      new Date().toISOString(),
    ]);

    await expect(rotateRefreshToken(first.raw, db)).rejects.toMatchObject({
      code: 'rotation_conflict',
    });
    expect(await liveInFamily(db, first.familyId)).toBe(0);
  });
});
