/**
 * Invites, WebAuthn challenges, service API keys, and the
 * sweep that replaces MongoDB's TTL monitor.
 *
 * The through-line is expiry: these tables used to have their old rows
 * removed for them, and the port has to keep two separate promises — that an
 * expired row is refused at read time whether or not anything swept it, and
 * that the sweep eventually removes it.
 */

import { describe, expect, test } from 'bun:test';
import type { ObjectId } from '../object-id.ts';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import { insertUser } from './auth.users.repo.ts';
import {
  createInvite,
  findInviteByCode,
  listInvites,
  redeemInvite,
  rescindInvite,
} from './auth.invites.repo.ts';
import { consumeChallenge, storeChallenge } from './auth.challenges.repo.ts';
import {
  findServiceApiKeyByKeyId,
  insertServiceApiKey,
  listServiceApiKeyRows,
  markServiceApiKeyUsed,
  revokeServiceApiKey,
} from './auth.service-api-keys.repo.ts';
import { sweepExpiredAuthRows } from './auth.expiry.ts';
import type { SqliteDb } from './db-handle.ts';

const NOW = '2026-09-18T10:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

async function seedUser(db: SqliteDb, email = 'owner@example.com'): Promise<ObjectId> {
  return await insertUser({ email, role: 'owner', created_at: NOW, last_seen_at: null }, db);
}

describe('invites', () => {
  test('an email-free invite redeems once', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const owner = await seedUser(db);
    const invite = await createInvite(owner, db);
    expect(invite).not.toHaveProperty('email');

    const redeemed = await redeemInvite(invite.code, db);
    expect(redeemed.invitedBy.toHexString()).toBe(owner.toHexString());
    await expect(redeemInvite(invite.code, db)).rejects.toThrow(/invite consumed/);
  });

  test('unknown, consumed, and expired invites report why redemption failed', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const owner = await seedUser(db);
    const invite = await createInvite(owner, db);

    await expect(redeemInvite('NOSUCH', db)).rejects.toThrow(/invite not found/);
    await redeemInvite(invite.code, db);
    await expect(redeemInvite(invite.code, db)).rejects.toThrow(/invite consumed/);
    const expired = await createInvite(owner, db);
    await db.write(`UPDATE invites SET expires_at = ? WHERE code = ?`, [PAST, expired.code]);
    await expect(redeemInvite(expired.code, db)).rejects.toThrow(/invite expired/);
  });

  test('a rejection carries the 410 the route reports', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const error = await redeemInvite('NOSUCH', db).catch((e: unknown) => e);
    expect((error as { status?: number }).status).toBe(410);
  });

  test('listing is in creation order and rescinding removes one', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const owner = await seedUser(db);
    const first = await createInvite(owner, db);
    await createInvite(owner, db);
    expect(await listInvites(db)).toHaveLength(2);

    await rescindInvite(first.code, db);
    expect(await listInvites(db)).toHaveLength(1);
  });

  test('expires_at comes back as the Date the DTO promises', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const owner = await seedUser(db);
    await createInvite(owner, db);
    expect((await listInvites(db))[0]?.expires_at).toBeInstanceOf(Date);
  });

  test('the registration peek reads an invite without spending it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const owner = await seedUser(db);
    const invite = await createInvite(owner, db);

    const peeked = await findInviteByCode(invite.code, db);
    expect(peeked).not.toHaveProperty('email');
    expect(peeked?.consumed_at).toBeNull();
    expect(peeked?.expires_at).toBeInstanceOf(Date);

    // Still redeemable afterwards — this is the whole point of the peek: the
    // invite may only be spent once the authenticator has produced a
    // credential, which happens on a later request.
    await redeemInvite(invite.code, db);
    expect((await findInviteByCode(invite.code, db))?.consumed_at).not.toBeNull();
  });

  test('the peek reports an unknown code as absent rather than throwing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    expect(await findInviteByCode('NOSUCH', db)).toBeNull();
  });
});

describe('WebAuthn challenges', () => {
  test('a challenge is spendable exactly once', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    await storeChallenge(
      {
        challenge: 'chal-1',
        purpose: 'authenticate',
        user_id: userId,
        email: 'owner@example.com',
        invite_code: null,
      },
      db,
    );
    const row = await consumeChallenge('chal-1', db);
    expect(row.purpose).toBe('authenticate');
    expect(row.user_id?.toHexString()).toBe(userId.toHexString());
    await expect(consumeChallenge('chal-1', db)).rejects.toThrow(/already consumed/);
  });

  test('a discoverable-credential challenge is bound to no account', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await storeChallenge(
      {
        challenge: 'chal-2',
        purpose: 'authenticate',
        user_id: null,
        email: null,
        invite_code: null,
      },
      db,
    );
    const row = await consumeChallenge('chal-2', db);
    expect(row.user_id).toBeNull();
    expect(row.email).toBeNull();
  });

  test('an expired challenge is spent as well as rejected', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await storeChallenge(
      {
        challenge: 'chal-3',
        purpose: 'register',
        user_id: null,
        email: 'a@x.com',
        invite_code: 'CODE',
      },
      db,
    );
    await db.write(`UPDATE challenges SET expires_at = ?`, [PAST]);
    await expect(consumeChallenge('chal-3', db)).rejects.toThrow(/challenge expired/);
    // Rejected AND gone, so a stale ceremony cannot be retried.
    expect(await db.read(`SELECT id FROM challenges`)).toHaveLength(0);
  });

  test('an unknown challenge is refused', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await expect(consumeChallenge('never-issued', db)).rejects.toThrow(/not found/);
  });
});

describe('service API keys', () => {
  async function seedKey(db: SqliteDb, keyId: string, overrides: { revoked?: boolean } = {}) {
    const owner = await seedUser(db, `${keyId}@x.com`);
    await insertServiceApiKey(
      {
        key_id: keyId,
        name: `Key ${keyId}`,
        secret_hash: 'f'.repeat(64),
        scopes: ['assets:search'],
        created_at: NOW,
        created_by: owner,
        expires_at: null,
        revoked_at: overrides.revoked === true ? NOW : null,
        last_used_at: null,
      },
      db,
    );
  }

  test('a stored key round-trips its scopes and null expiry', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await seedKey(db, 'a'.repeat(16));
    const key = await findServiceApiKeyByKeyId('a'.repeat(16), db);
    expect(key?.scopes).toEqual(['assets:search']);
    expect(key?.expires_at).toBeNull();
  });

  test('an expiry comes back as the Date the DTO promises', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const owner = await seedUser(db);
    await insertServiceApiKey(
      {
        key_id: 'b'.repeat(16),
        name: 'Expiring',
        secret_hash: 'f'.repeat(64),
        scopes: ['assets:search'],
        created_at: NOW,
        created_by: owner,
        expires_at: new Date('2027-01-01T00:00:00.000Z'),
        revoked_at: null,
        last_used_at: null,
      },
      db,
    );
    const key = await findServiceApiKeyByKeyId('b'.repeat(16), db);
    expect(key?.expires_at).toBeInstanceOf(Date);
    expect(key?.expires_at?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  test('revoking works once and reports nothing the second time', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await seedKey(db, 'c'.repeat(16));
    expect(await revokeServiceApiKey('c'.repeat(16), db)).toBe(true);
    expect(await revokeServiceApiKey('c'.repeat(16), db)).toBe(false);
  });

  test('a malformed key id is refused without a query', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    expect(await revokeServiceApiKey('not-a-key-id', db)).toBe(false);
  });

  test('a revoked key is not re-marked as recently used', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await seedKey(db, 'd'.repeat(16), { revoked: true });
    const key = await findServiceApiKeyByKeyId('d'.repeat(16), db);
    await markServiceApiKeyUsed(key!._id, '2026-09-18T12:00:00.000Z', db);
    expect((await findServiceApiKeyByKeyId('d'.repeat(16), db))?.last_used_at).toBeNull();
  });

  test('listing is newest first', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const owner = await seedUser(db);
    for (const [keyId, createdAt] of [
      ['e'.repeat(16), '2026-01-01T00:00:00.000Z'],
      ['f'.repeat(16), '2026-06-01T00:00:00.000Z'],
    ] as const) {
      await insertServiceApiKey(
        {
          key_id: keyId,
          name: keyId,
          secret_hash: '0'.repeat(64),
          scopes: ['assets:search'],
          created_at: createdAt,
          created_by: owner,
          expires_at: null,
          revoked_at: null,
          last_used_at: null,
        },
        db,
      );
    }
    expect((await listServiceApiKeyRows(db)).map((k) => k.key_id)).toEqual([
      'f'.repeat(16),
      'e'.repeat(16),
    ]);
  });
});

describe('the expiry sweep', () => {
  test('removes expired rows from every table and leaves live ones', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const owner = await seedUser(db);

    await createInvite(owner, db);
    await storeChallenge(
      { challenge: 'live', purpose: 'register', user_id: null, email: null, invite_code: null },
      db,
    );
    // One expired row in each of two tables, written past the repositories
    // because they all refuse to mint something already dead.
    await db.write(
      `INSERT INTO challenges (id, challenge, purpose, expires_at)
       VALUES ('000000000000000000000001', 'stale', 'register', ?)`,
      [PAST],
    );
    await db.write(
      `INSERT INTO invites (id, code, invited_by, expires_at)
       VALUES ('000000000000000000000002', 'STALECODE', ?, ?)`,
      [owner.toHexString(), PAST],
    );
    const result = await sweepExpiredAuthRows(undefined, db);
    expect(result.failures).toEqual([]);
    expect(result.removed.challenges).toBe(1);
    expect(result.removed.invites).toBe(1);
    expect(result.total).toBe(2);

    expect(await db.read(`SELECT id FROM challenges`)).toHaveLength(1);
    expect(await db.read(`SELECT id FROM invites`)).toHaveLength(1);
  });

  test('a clean database sweeps to zero without failing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const result = await sweepExpiredAuthRows(undefined, db);
    expect(result.total).toBe(0);
    expect(result.failures).toEqual([]);
  });

  test('the cutoff is injectable, so a test never has to sleep', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const owner = await seedUser(db);
    await createInvite(owner, db);
    // Far enough in the future that the fifteen-minute invite has lapsed.
    const result = await sweepExpiredAuthRows('2030-01-01T00:00:00.000Z', db);
    expect(result.removed.invites).toBe(1);
  });
});

describe('the challenge lookup is keyed', () => {
  test('verifying a ceremony seeks the challenge index rather than scanning', async () => {
    using handle = await createTestDatabase();
    // `consumeChallenge` runs this predicate once per WebAuthn register and
    // login verification. `challenge` is not the primary key, so without its
    // own index every verification is a table scan.
    const rows = handle.db
      .query(`EXPLAIN QUERY PLAN SELECT id FROM challenges WHERE challenge = ?`)
      .all('abc') as Array<{ detail: string }>;
    const detail = rows.map((row) => row.detail).join('\n');
    expect(detail).toContain('challenges_challenge');
    expect(detail).not.toContain('SCAN');
  });
});
