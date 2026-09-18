/**
 * Accounts and passkeys: the behaviour the route handlers depend on.
 *
 * The cases that earn their place are the ones a naive port gets wrong —
 * "file access was never set" reading as true rather than false, the
 * last-owner count, the credential reads that must not carry key bytes, and
 * the ownership scoping on delete.
 */

import { describe, expect, test } from 'bun:test';
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';
import { testSqliteDb } from './assets.test-helpers.ts';
import {
  anyUserExists,
  countCredentialsForUser,
  countOtherOwners,
  deleteCredential,
  findCredentialByCredentialId,
  findUserByEmail,
  findUserById,
  insertCredential,
  insertUser,
  listCredentialDescriptorsForUser,
  listCredentialSummariesForUser,
  listUsers,
  touchCredential,
  touchUserLastSeen,
  updateUser,
} from './auth.users.repo.ts';
import type { SqliteDb } from './db-handle.ts';

const NOW = '2026-09-18T10:00:00.000Z';

function owner(email = 'owner@example.com') {
  return { email, role: 'owner' as const, created_at: NOW, last_seen_at: null };
}

async function seedOwner(db: SqliteDb, email?: string) {
  return await insertUser(owner(email), db);
}

describe('users', () => {
  test('an account with no file_access setting comes back without the key', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await seedOwner(db);
    const user = await findUserById(id, db);
    // Absent means "not set", which permissions.ts reads as true. A `false`
    // here would silently revoke file access for every pre-#2893 account.
    expect(user).not.toBeNull();
    expect(user).not.toHaveProperty('file_access');
  });

  test('an explicit false is preserved', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await insertUser(
      {
        email: 'm@example.com',
        role: 'member',
        file_access: false,
        created_at: NOW,
        last_seen_at: null,
      },
      db,
    );
    expect((await findUserById(id, db))?.file_access).toBe(false);
  });

  test('email lookup is exact, not case-folded', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await seedOwner(db, 'owner@example.com');
    expect(await findUserByEmail('owner@example.com', db)).not.toBeNull();
    expect(await findUserByEmail('Owner@example.com', db)).toBeNull();
  });

  test('two accounts cannot differ only in the case of their email', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await seedOwner(db, 'owner@example.com');
    await expect(seedOwner(db, 'OWNER@example.com')).rejects.toThrow(/UNIQUE/i);
  });

  test('listUsers is oldest first', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await insertUser({ ...owner('a@x.com'), created_at: '2026-01-01T00:00:00.000Z' }, db);
    await insertUser({ ...owner('b@x.com'), created_at: '2025-01-01T00:00:00.000Z' }, db);
    expect((await listUsers(db)).map((u) => u.email)).toEqual(['b@x.com', 'a@x.com']);
  });

  test('anyUserExists flips on the first account', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    expect(await anyUserExists(db)).toBe(false);
    await seedOwner(db);
    expect(await anyUserExists(db)).toBe(true);
  });

  test('countOtherOwners excludes the user being demoted', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const first = await seedOwner(db, 'a@x.com');
    expect(await countOtherOwners(first, db)).toBe(0);
    await seedOwner(db, 'b@x.com');
    expect(await countOtherOwners(first, db)).toBe(1);
  });

  test('updateUser writes only the fields the patch names', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await insertUser(
      { email: 'm@x.com', role: 'member', file_access: false, created_at: NOW, last_seen_at: null },
      db,
    );
    await updateUser(id, { role: 'owner' }, db);
    const user = await findUserById(id, db);
    expect(user?.role).toBe('owner');
    expect(user?.file_access).toBe(false);
  });

  test('updateUser with nothing to change reports no match rather than throwing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await seedOwner(db);
    expect((await updateUser(id, {}, db)).matchedCount).toBe(0);
  });

  test('touchUserLastSeen stamps the sign-in time', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const id = await seedOwner(db);
    await touchUserLastSeen(id, '2026-09-18T11:00:00.000Z', db);
    expect((await findUserById(id, db))?.last_seen_at).toBe('2026-09-18T11:00:00.000Z');
  });
});

describe('credentials', () => {
  const key = Buffer.from([1, 2, 3, 4, 5]);

  async function seedCredential(
    db: SqliteDb,
    userId: Awaited<ReturnType<typeof insertUser>>,
    n = 1,
  ) {
    return await insertCredential(
      {
        user_id: userId,
        credential_id: `cred-${n}`,
        public_key: key,
        counter: 0,
        transports: ['internal', 'hybrid'],
        device_label: `Device ${n}`,
        created_at: NOW,
        last_used_at: null,
      },
      db,
    );
  }

  test('the verification read returns the key bytes intact', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedOwner(db);
    await seedCredential(db, userId);
    const cred = await findCredentialByCredentialId('cred-1', db);
    expect(cred?.public_key).toBeInstanceOf(Buffer);
    expect([...(cred?.public_key ?? [])]).toEqual([1, 2, 3, 4, 5]);
    expect(cred?.transports).toEqual(['internal', 'hybrid']);
    expect(cred?.user_id.toHexString()).toBe(userId.toHexString());
  });

  test('the account-page list carries no key bytes', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedOwner(db);
    await seedCredential(db, userId);
    const summaries = await listCredentialSummariesForUser(userId, db);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).not.toHaveProperty('public_key');
    expect(summaries[0]?.device_label).toBe('Device 1');
  });

  test('the ceremony list carries ids and transports', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedOwner(db);
    await seedCredential(db, userId);
    expect(await listCredentialDescriptorsForUser(userId, db)).toEqual([
      { credential_id: 'cred-1', transports: ['internal', 'hybrid'] },
    ]);
  });

  test('a successful assertion advances the counter', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedOwner(db);
    const credId = await seedCredential(db, userId);
    await touchCredential(credId, 42, '2026-09-18T12:00:00.000Z', db);
    const cred = await findCredentialByCredentialId('cred-1', db);
    expect(cred?.counter).toBe(42);
    expect(cred?.last_used_at).toBe('2026-09-18T12:00:00.000Z');
  });

  test('deleting is scoped to the owner', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const mine = await seedOwner(db, 'a@x.com');
    const theirs = await seedOwner(db, 'b@x.com');
    const credId = await seedCredential(db, mine);
    expect((await deleteCredential(credId, theirs, db)).deletedCount).toBe(0);
    expect((await deleteCredential(credId, mine, db)).deletedCount).toBe(1);
  });

  test('countCredentialsForUser backs the last-credential guard', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedOwner(db);
    await seedCredential(db, userId, 1);
    await seedCredential(db, userId, 2);
    expect(await countCredentialsForUser(userId, db)).toBe(2);
  });

  test('removing a user takes their passkeys with them', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedOwner(db);
    await seedCredential(db, userId);
    await db.write(`DELETE FROM users WHERE id = ?`, [userId.toHexString()]);
    expect(await findCredentialByCredentialId('cred-1', db)).toBeNull();
  });
});
