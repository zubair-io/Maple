/**
 * Invites, WebAuthn challenges, service API keys, image capabilities, and the
 * sweep that replaces MongoDB's TTL monitor.
 *
 * The through-line is expiry: five of these tables used to have their old rows
 * removed for them, and the port has to keep two separate promises — that an
 * expired row is refused at read time whether or not anything swept it, and
 * that the sweep eventually removes it.
 */

import { describe, expect, test } from 'bun:test';
import type { ObjectId } from 'mongodb';
import { createTestDatabase } from '../test-sqlite.test-helpers.ts';
import { testSqliteDb } from './assets.test-helpers.ts';
import { insertUser } from './auth.users.repo.ts';
import { createInvite, listInvites, redeemInvite, rescindInvite } from './auth.invites.repo.ts';
import { consumeChallenge, storeChallenge } from './auth.challenges.repo.ts';
import {
  findServiceApiKeyByKeyId,
  insertServiceApiKey,
  listServiceApiKeyRows,
  markServiceApiKeyUsed,
  revokeServiceApiKey,
} from './auth.service-api-keys.repo.ts';
import { imageCapabilityIsValid, issueImageCapability } from './auth.image-capability.repo.ts';
import { sweepExpiredAuthRows } from './auth.expiry.ts';
import type { SqliteDb } from './db-handle.ts';

const NOW = '2026-09-18T10:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

async function seedUser(db: SqliteDb, email = 'owner@example.com'): Promise<ObjectId> {
  return await insertUser({ email, role: 'owner', created_at: NOW, last_seen_at: null }, db);
}

describe('invites', () => {
  test('an invite redeems once, for the address it names', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const owner = await seedUser(db);
    const invite = await createInvite(owner, 'Guest@Example.com', db);
    expect(invite.email).toBe('guest@example.com');

    const redeemed = await redeemInvite(invite.code, 'guest@example.com', db);
    expect(redeemed.invitedBy.toHexString()).toBe(owner.toHexString());
    await expect(redeemInvite(invite.code, 'guest@example.com', db)).rejects.toThrow(
      /invite consumed/,
    );
  });

  test('each rejection says which thing was wrong', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const owner = await seedUser(db);
    const invite = await createInvite(owner, 'guest@example.com', db);

    await expect(redeemInvite('NOSUCH', 'guest@example.com', db)).rejects.toThrow(
      /invite not found/,
    );
    await expect(redeemInvite(invite.code, 'other@example.com', db)).rejects.toThrow(
      /invite\/email mismatch/,
    );
    await db.write(`UPDATE invites SET expires_at = ?`, [PAST]);
    await expect(redeemInvite(invite.code, 'guest@example.com', db)).rejects.toThrow(
      /invite expired/,
    );
  });

  test('a rejection carries the 410 the route reports', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const error = await redeemInvite('NOSUCH', 'g@x.com', db).catch((e: unknown) => e);
    expect((error as { status?: number }).status).toBe(410);
  });

  test('listing is in creation order and rescinding removes one', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const owner = await seedUser(db);
    const first = await createInvite(owner, 'a@x.com', db);
    await createInvite(owner, 'b@x.com', db);
    expect((await listInvites(db)).map((i) => i.email)).toEqual(['a@x.com', 'b@x.com']);

    await rescindInvite(first.code, db);
    expect((await listInvites(db)).map((i) => i.email)).toEqual(['b@x.com']);
  });

  test('expires_at comes back as the Date the DTO promises', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const owner = await seedUser(db);
    await createInvite(owner, 'a@x.com', db);
    expect((await listInvites(db))[0]?.expires_at).toBeInstanceOf(Date);
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

describe('image capabilities', () => {
  const token = 'T'.repeat(43);

  test('a live grant authorises its own path and no other', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await issueImageCapability(token, '/api/thumb/abc', new Date(Date.now() + 60_000), db);
    expect(await imageCapabilityIsValid(token, '/api/thumb/abc', db)).toBe(true);
    expect(await imageCapabilityIsValid(token, '/api/thumb/other', db)).toBe(false);
  });

  test('an expired grant is refused even before anything sweeps it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await issueImageCapability(token, '/api/preview/abc', new Date(Date.now() - 1000), db);
    expect(await imageCapabilityIsValid(token, '/api/preview/abc', db)).toBe(false);
  });

  test('the token itself is never stored', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await issueImageCapability(token, '/api/thumb/abc', new Date(Date.now() + 60_000), db);
    const rows = await db.read<Record<string, unknown>>(`SELECT * FROM image_access_tokens`);
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});

describe('the expiry sweep', () => {
  test('removes expired rows from every table and leaves live ones', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const owner = await seedUser(db);

    await createInvite(owner, 'live@x.com', db);
    await storeChallenge(
      { challenge: 'live', purpose: 'register', user_id: null, email: null, invite_code: null },
      db,
    );
    await issueImageCapability(
      'L'.repeat(43),
      '/api/thumb/live',
      new Date(Date.now() + 60_000),
      db,
    );

    // One expired row in each of three tables, written past the repositories
    // because they all refuse to mint something already dead.
    await db.write(
      `INSERT INTO challenges (id, challenge, purpose, expires_at)
       VALUES ('000000000000000000000001', 'stale', 'register', ?)`,
      [PAST],
    );
    await db.write(
      `INSERT INTO invites (id, code, email, invited_by, expires_at)
       VALUES ('000000000000000000000002', 'STALECODE', 'x@x.com', ?, ?)`,
      [owner.toHexString(), PAST],
    );
    await db.write(
      `INSERT INTO image_access_tokens (id, path, purpose, created_at, expires_at)
       VALUES (?, '/api/thumb/stale', 'image-read', ?, ?)`,
      ['0'.repeat(64), NOW, PAST],
    );

    const result = await sweepExpiredAuthRows(undefined, db);
    expect(result.failures).toEqual([]);
    expect(result.removed.challenges).toBe(1);
    expect(result.removed.invites).toBe(1);
    expect(result.removed.image_access_tokens).toBe(1);
    expect(result.total).toBe(3);

    expect(await db.read(`SELECT id FROM challenges`)).toHaveLength(1);
    expect(await imageCapabilityIsValid('L'.repeat(43), '/api/thumb/live', db)).toBe(true);
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
    await createInvite(owner, 'a@x.com', db);
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
