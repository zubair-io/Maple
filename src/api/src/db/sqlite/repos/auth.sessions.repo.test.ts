/**
 * Refresh-token rotation and the two one-time handoff codes.
 *
 * These are the paths where a port that is merely "close" is a security bug,
 * so the tests are about the properties rather than the fields: a token can be
 * rotated exactly once, a replayed token is either forgiven or treated as
 * theft depending on how long ago it was spent, a code can be spent exactly
 * once, and a wrong PKCE verifier neither succeeds nor burns the code.
 *
 * The native-app login handoff is covered end to end here — issue, redeem, and
 * the poll-based claim that exists because Chromium will not launch
 * `maple-app://` without a user gesture (#3063). That flow has broken before at
 * the receiving app rather than at the sender, so both of its redeem paths get
 * their own cases.
 */

import { describe, expect, test } from 'bun:test';
import type { ObjectId } from 'mongodb';
import { createTestDatabase, testSqliteDb } from '../test-sqlite.test-helpers.ts';
import { insertUser } from './auth.users.repo.ts';
import {
  claimNativeCode,
  issueLanHandoffCode,
  issueNativeCode,
  pkceS256,
  redeemLanHandoffCode,
  redeemNativeCode,
} from './auth.codes.repo.ts';
import {
  hasLivePrimaryRefreshToken,
  listDeviceSessions,
  revokeDeviceSession,
} from './auth.device-sessions.repo.ts';
import {
  issueRefreshToken,
  RefreshError,
  REFRESH_GRACE_MS,
  revokeChain,
  revokeFamilyByToken,
  rotateRefreshToken,
} from './auth.refresh.repo.ts';
import type { SqliteDb } from './db-handle.ts';

const NOW = '2026-09-18T10:00:00.000Z';

async function seedUser(db: SqliteDb, email = 'owner@example.com'): Promise<ObjectId> {
  return await insertUser({ email, role: 'owner', created_at: NOW, last_seen_at: null }, db);
}

/**
 * Backdate a token's revocation so it falls outside the grace window.
 *
 * Derived from `REFRESH_GRACE_MS` rather than hard-coded, so widening or
 * narrowing the window cannot leave this test quietly asserting the wrong side
 * of it.
 */
async function backdateRevocation(db: SqliteDb): Promise<void> {
  await db.write(`UPDATE refresh_tokens SET revoked_at = ? WHERE revoked_at IS NOT NULL`, [
    new Date(Date.now() - REFRESH_GRACE_MS - 1_000).toISOString(),
  ]);
}

describe('refresh token rotation', () => {
  test('rotating returns a new token in the same family', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const first = await issueRefreshToken(userId, 'Laptop', {}, db);
    const second = await rotateRefreshToken(first.raw, db);
    expect(second.raw).not.toBe(first.raw);
    expect(second.familyId.toHexString()).toBe(first.familyId.toHexString());
    expect(second.userId.toHexString()).toBe(userId.toHexString());
  });

  test('the successor is linked from the token it replaced', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const first = await issueRefreshToken(userId, 'Laptop', {}, db);
    await rotateRefreshToken(first.raw, db);
    const rows = await db.read<{ revoked_at: string | null; replaced_by: string | null }>(
      `SELECT revoked_at, replaced_by FROM refresh_tokens WHERE replaced_by IS NOT NULL`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
    // The link points at a row that exists — the foreign key would have
    // refused it otherwise, which is why the successor is inserted first.
    const successor = await db.read(`SELECT id FROM refresh_tokens WHERE id = ?`, [
      rows[0]?.replaced_by ?? '',
    ]);
    expect(successor).toHaveLength(1);
  });

  test('platform and the insecure-cookie marker ride along the whole lineage', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const first = await issueRefreshToken(
      userId,
      'Apple TV',
      { platform: 'tvos', secure: false },
      db,
    );
    const second = await rotateRefreshToken(first.raw, db);
    expect(second.secure).toBe(false);
    const rows = await db.read<{ platform: string | null }>(
      `SELECT platform FROM refresh_tokens WHERE revoked_at IS NULL`,
    );
    expect(rows.map((r) => r.platform)).toEqual(['tvos']);
  });

  test('an unknown token is rejected as unknown', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await expect(rotateRefreshToken('nope', db)).rejects.toMatchObject({
      code: 'unknown_token',
    });
  });

  test('an expired token is rejected as expired', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const issued = await issueRefreshToken(userId, 'Laptop', {}, db);
    await db.write(`UPDATE refresh_tokens SET expires_at = ?`, ['2020-01-01T00:00:00.000Z']);
    await expect(rotateRefreshToken(issued.raw, db)).rejects.toMatchObject({
      code: 'token_expired',
    });
  });

  test('replaying a just-rotated token is forgiven while the family is live', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const first = await issueRefreshToken(userId, 'Laptop', {}, db);
    await rotateRefreshToken(first.raw, db);
    // The lost-response case: the client never saw the successor and retries.
    const retry = await rotateRefreshToken(first.raw, db);
    expect(retry.familyId.toHexString()).toBe(first.familyId.toHexString());
  });

  test('replaying a long-dead token revokes the whole family', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const first = await issueRefreshToken(userId, 'Laptop', {}, db);
    await rotateRefreshToken(first.raw, db);
    await backdateRevocation(db);

    await expect(rotateRefreshToken(first.raw, db)).rejects.toMatchObject({
      code: 'reuse_detected',
    });
    const live = await db.read(`SELECT id FROM refresh_tokens WHERE revoked_at IS NULL`);
    expect(live).toHaveLength(0);
  });

  test('a token whose family was revoked is reuse, not a retry', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const first = await issueRefreshToken(userId, 'Laptop', {}, db);
    await revokeFamilyByToken(first.raw, db);
    const error = await rotateRefreshToken(first.raw, db).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefreshError);
    expect((error as RefreshError).code).toBe('reuse_detected');
  });

  test('revoking a family keeps the original revocation time of a spent token', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const first = await issueRefreshToken(userId, 'Laptop', {}, db);
    await rotateRefreshToken(first.raw, db);
    const before = await db.read<{ revoked_at: string }>(
      `SELECT revoked_at FROM refresh_tokens WHERE revoked_at IS NOT NULL`,
    );
    await revokeChain(userId, db);
    const after = await db.read<{ revoked_at: string }>(
      `SELECT revoked_at FROM refresh_tokens WHERE id = (
         SELECT id FROM refresh_tokens WHERE replaced_by IS NOT NULL)`,
    );
    // The grace window measures from this timestamp, so re-stamping it would
    // silently extend it.
    expect(after[0]?.revoked_at).toBe(before[0]?.revoked_at ?? '');
  });
});

describe('device sessions', () => {
  test('only platform-marked families are listed', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    await issueRefreshToken(userId, 'Browser', {}, db);
    await issueRefreshToken(userId, 'Apple TV', { platform: 'tvos' }, db);
    const sessions = await listDeviceSessions(userId, db);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.label).toBe('Apple TV');
    expect(sessions[0]?.platform).toBe('tvos');
  });

  test('a revoked family drops off the list', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const tv = await issueRefreshToken(userId, 'Apple TV', { platform: 'tvos' }, db);
    expect(await revokeDeviceSession(userId, tv.familyId, db)).toBe(true);
    expect(await listDeviceSessions(userId, db)).toHaveLength(0);
  });

  test('another user cannot revoke a device session', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const mine = await seedUser(db, 'a@x.com');
    const theirs = await seedUser(db, 'b@x.com');
    const tv = await issueRefreshToken(mine, 'Apple TV', { platform: 'tvos' }, db);
    expect(await revokeDeviceSession(theirs, tv.familyId, db)).toBe(false);
    expect(await listDeviceSessions(mine, db)).toHaveLength(1);
  });

  test('an ordinary login cannot be killed through the device panel', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const browser = await issueRefreshToken(userId, 'Browser', {}, db);
    expect(await revokeDeviceSession(userId, browser.familyId, db)).toBe(false);
  });
});

/**
 * The proof a device must present before the server will mint it a 90-day
 * credential. Every rejection below is a way a leaked or downgraded token could
 * otherwise be laundered into one.
 */
describe('the pairing proof', () => {
  test("accepts the caller's own live primary-login token", async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const own = await issueRefreshToken(userId, 'Safari on Mac', {}, db);
    expect(await hasLivePrimaryRefreshToken(userId, own.raw, db)).toBe(true);
  });

  test('refuses a token that is not a token, and one belonging to someone else', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const mine = await seedUser(db, 'a@x.com');
    const theirs = await seedUser(db, 'b@x.com');
    const other = await issueRefreshToken(theirs, 'Their Safari', {}, db);
    expect(await hasLivePrimaryRefreshToken(mine, 'not-a-real-token', db)).toBe(false);
    expect(await hasLivePrimaryRefreshToken(mine, other.raw, db)).toBe(false);
  });

  test("refuses a paired device's own credential — only primary logins pair", async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const tv = await issueRefreshToken(userId, 'Apple TV', { platform: 'tvos' }, db);
    expect(await hasLivePrimaryRefreshToken(userId, tv.raw, db)).toBe(false);
  });

  test('refuses an expired token, and a live-looking row inside a logged-out family', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);

    const expired = await issueRefreshToken(userId, 'Old Session', {}, db);
    await db.write(`UPDATE refresh_tokens SET expires_at = ? WHERE family_id = ?`, [
      '2020-01-01T00:00:00.000Z',
      expired.familyId.toHexString(),
    ]);
    expect(await hasLivePrimaryRefreshToken(userId, expired.raw, db)).toBe(false);

    // The logout-race artifact: the row itself still looks live, but its
    // lineage was killed — a grace-window re-mint can leave exactly this.
    const loggedOut = await issueRefreshToken(userId, 'Old Phone', {}, db);
    await db.write(`UPDATE refresh_tokens SET family_revoked_at = ? WHERE family_id = ?`, [
      NOW,
      loggedOut.familyId.toHexString(),
    ]);
    expect(await hasLivePrimaryRefreshToken(userId, loggedOut.raw, db)).toBe(false);
  });
});

describe('native login handoff', () => {
  const verifier = 'a'.repeat(64);

  test('a code issued by the web app redeems once for the native app', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const { code } = await issueNativeCode(
      { userId, codeChallenge: pkceS256(verifier), state: 'state-1', deviceLabel: 'Mac' },
      db,
    );

    const redeemed = await redeemNativeCode(code, verifier, db);
    expect(redeemed?.userId.toHexString()).toBe(userId.toHexString());
    expect(redeemed?.deviceLabel).toBe('Mac');
    expect(redeemed?.state).toBe('state-1');

    // Single use: the second attempt gets nothing, not a second session.
    expect(await redeemNativeCode(code, verifier, db)).toBeNull();
  });

  test('a wrong verifier neither succeeds nor burns the code', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const { code } = await issueNativeCode(
      { userId, codeChallenge: pkceS256(verifier), state: 'state-1', deviceLabel: 'Mac' },
      db,
    );
    expect(await redeemNativeCode(code, 'b'.repeat(64), db)).toBeNull();
    // The real app can still complete its login.
    expect(await redeemNativeCode(code, verifier, db)).not.toBeNull();
  });

  test('an expired code is refused', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const { code } = await issueNativeCode(
      { userId, codeChallenge: pkceS256(verifier), state: 'state-1', deviceLabel: 'Mac' },
      db,
    );
    await db.write(`UPDATE native_auth_codes SET expires_at = ?`, ['2020-01-01T00:00:00.000Z']);
    expect(await redeemNativeCode(code, verifier, db)).toBeNull();
  });

  test('the polling claim path redeems by state and verifier, without the code', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    await issueNativeCode(
      { userId, codeChallenge: pkceS256(verifier), state: 'state-2', deviceLabel: 'Mac' },
      db,
    );
    const claimed = await claimNativeCode('state-2', verifier, db);
    expect(claimed?.userId.toHexString()).toBe(userId.toHexString());
    expect(claimed?.state).toBe('state-2');
    expect(await claimNativeCode('state-2', verifier, db)).toBeNull();
  });

  test('the polling claim spends one code even when a state repeats', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    await issueNativeCode(
      { userId, codeChallenge: pkceS256(verifier), state: 'state-3', deviceLabel: 'Mac' },
      db,
    );
    await issueNativeCode(
      { userId, codeChallenge: pkceS256(verifier), state: 'state-3', deviceLabel: 'Mac' },
      db,
    );
    expect(await claimNativeCode('state-3', verifier, db)).not.toBeNull();
    const spent = await db.read<{ n: number }>(
      `SELECT COUNT(*) AS n FROM native_auth_codes WHERE consumed_at IS NOT NULL`,
    );
    expect(spent[0]?.n).toBe(1);
  });

  test('the polling claim rejects a wrong verifier', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    await issueNativeCode(
      { userId, codeChallenge: pkceS256(verifier), state: 'state-4', deviceLabel: 'Mac' },
      db,
    );
    expect(await claimNativeCode('state-4', 'c'.repeat(64), db)).toBeNull();
  });

  test('nothing is stored that the raw code could be recovered from', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const { code } = await issueNativeCode(
      { userId, codeChallenge: pkceS256(verifier), state: 'state-5', deviceLabel: 'Mac' },
      db,
    );
    const rows = await db.read<Record<string, unknown>>(`SELECT * FROM native_auth_codes`);
    expect(JSON.stringify(rows)).not.toContain(code);
  });
});

describe('LAN handoff', () => {
  test('a code redeems once for the same browser on the LAN address', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const { code } = await issueLanHandoffCode({ userId, deviceLabel: 'Safari' }, db);
    const redeemed = await redeemLanHandoffCode(code, db);
    expect(redeemed?.userId.toHexString()).toBe(userId.toHexString());
    expect(redeemed?.deviceLabel).toBe('Safari');
    expect(await redeemLanHandoffCode(code, db)).toBeNull();
  });

  test('an unknown or expired code is refused the same way', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = await seedUser(db);
    const { code } = await issueLanHandoffCode({ userId, deviceLabel: 'Safari' }, db);
    await db.write(`UPDATE lan_handoff_codes SET expires_at = ?`, ['2020-01-01T00:00:00.000Z']);
    expect(await redeemLanHandoffCode(code, db)).toBeNull();
    expect(await redeemLanHandoffCode('never-issued', db)).toBeNull();
  });
});

describe('the native-code claim lookup is keyed', () => {
  test('polling for a pending code seeks the state index rather than scanning', async () => {
    using handle = await createTestDatabase();
    // `claimNativeCode` runs this once per poll, and the Apple shell polls in
    // a loop while it waits for the browser to finish signing in.
    const rows = handle.db
      .query(
        `EXPLAIN QUERY PLAN
           SELECT id FROM native_auth_codes
            WHERE state = ? AND code_challenge = ? AND consumed_at IS NULL AND expires_at > ?
            ORDER BY created_at, id LIMIT 1`,
      )
      .all('s', 'c', NOW) as Array<{ detail: string }>;
    const detail = rows.map((row) => row.detail).join('\n');
    expect(detail).toContain('native_auth_codes_state');
    expect(detail).not.toContain('SCAN');
  });
});
