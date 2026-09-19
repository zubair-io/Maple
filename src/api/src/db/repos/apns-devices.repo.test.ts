/**
 * `apns_device_tokens` behaviour through the repository.
 *
 * The rules worth pinning are the ones a naive port loses: a re-registration
 * has to update the existing row rather than create a second one that APNs will
 * never match on prune, a prune has to reach across users because a dead token
 * is dead for everyone, and the two `Date`-typed DTO fields have to come back
 * as `Date`s — one route calls `.toISOString()` on `updated_at`.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { newObjectIdHex } from '../object-id.ts';
import { createTestDatabase, run, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import {
  listAllDeviceTokens,
  listDeviceTokensForUser,
  pruneDeviceTokens,
  registerDeviceToken,
  unregisterDeviceToken,
} from './apns-devices.repo.ts';
import { toObjectId } from './values.ts';

/** A 64-character hex device token, the only shape a Maple client sends. */
function token(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

/** Inserts a user and returns its id. `apns_device_tokens.user_id` is a foreign
 * key, and foreign keys are enforced in the test harness. */
function insertUser(db: Database): string {
  const id = newObjectIdHex();
  run(
    db,
    `INSERT INTO users (id, email, role, created_at) VALUES (?, ?, 'member', ?)`,
    id,
    `${id}@example.test`,
    new Date().toISOString(),
  );
  return id;
}

describe('registerDeviceToken', () => {
  test('stores a registration and reads it back with Date timestamps', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = insertUser(handle.db);

    await registerDeviceToken(
      {
        userId: toObjectId(userId),
        deviceToken: token(1),
        platform: 'ios',
        environment: 'production',
      },
      db,
    );

    const [device] = await listDeviceTokensForUser(toObjectId(userId), db);
    expect(device?.device_token).toBe(token(1));
    expect(device?.platform).toBe('ios');
    expect(device?.environment).toBe('production');
    expect(device?.user_id.toHexString()).toBe(userId);
    expect(device?.created_at).toBeInstanceOf(Date);
    expect(device?.updated_at).toBeInstanceOf(Date);
  });

  test('re-registering the same pair updates the row instead of duplicating', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = insertUser(handle.db);
    const input = {
      userId: toObjectId(userId),
      deviceToken: token(2),
      platform: 'ios' as const,
      environment: 'sandbox' as const,
    };

    await registerDeviceToken(input, db);
    // Pin created_at back so "kept on update" is distinguishable from "rewritten
    // in the same millisecond".
    run(
      handle.db,
      `UPDATE apns_device_tokens SET created_at = ?, updated_at = ? WHERE device_token = ?`,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      token(2),
    );
    await registerDeviceToken({ ...input, environment: 'production' }, db);

    const devices = await listDeviceTokensForUser(toObjectId(userId), db);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.environment).toBe('production');
    expect(devices[0]?.created_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(devices[0]!.updated_at.getTime()).toBeGreaterThan(devices[0]!.created_at.getTime());
  });

  test('keeps one row per device for a user with several devices', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = insertUser(handle.db);

    for (const seed of [3, 4]) {
      await registerDeviceToken(
        {
          userId: toObjectId(userId),
          deviceToken: token(seed),
          platform: 'macos',
          environment: 'production',
        },
        db,
      );
    }
    expect(await listDeviceTokensForUser(toObjectId(userId), db)).toHaveLength(2);
  });

  test('refuses a registration for a user that does not exist', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await expect(
      registerDeviceToken(
        {
          userId: toObjectId(newObjectIdHex()),
          deviceToken: token(5),
          platform: 'ios',
          environment: 'production',
        },
        db,
      ),
    ).rejects.toThrow();
  });
});

describe('listDeviceTokensForUser', () => {
  test('orders most recently refreshed first', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = insertUser(handle.db);

    for (const seed of [6, 7]) {
      await registerDeviceToken(
        {
          userId: toObjectId(userId),
          deviceToken: token(seed),
          platform: 'ios',
          environment: 'production',
        },
        db,
      );
    }
    run(
      handle.db,
      `UPDATE apns_device_tokens SET updated_at = ? WHERE device_token = ?`,
      '2026-05-01T00:00:00.000Z',
      token(6),
    );
    run(
      handle.db,
      `UPDATE apns_device_tokens SET updated_at = ? WHERE device_token = ?`,
      '2026-04-01T00:00:00.000Z',
      token(7),
    );

    const devices = await listDeviceTokensForUser(toObjectId(userId), db);
    expect(devices.map((d) => d.device_token)).toEqual([token(6), token(7)]);
  });

  test('does not see devices registered by a different user', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const mine = insertUser(handle.db);
    const theirs = insertUser(handle.db);

    await registerDeviceToken(
      {
        userId: toObjectId(theirs),
        deviceToken: token(8),
        platform: 'ios',
        environment: 'sandbox',
      },
      db,
    );
    expect(await listDeviceTokensForUser(toObjectId(mine), db)).toHaveLength(0);
    expect(await listAllDeviceTokens(db)).toHaveLength(1);
  });
});

describe('unregisterDeviceToken', () => {
  test('removes the (user, device) pairing and reports one row', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = insertUser(handle.db);

    await registerDeviceToken(
      {
        userId: toObjectId(userId),
        deviceToken: token(9),
        platform: 'ios',
        environment: 'production',
      },
      db,
    );
    expect(
      await unregisterDeviceToken({ userId: toObjectId(userId), deviceToken: token(9) }, db),
    ).toBe(1);
    expect(await listDeviceTokensForUser(toObjectId(userId), db)).toHaveLength(0);
  });

  test('is a no-op for a device that was never registered', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = insertUser(handle.db);
    expect(
      await unregisterDeviceToken({ userId: toObjectId(userId), deviceToken: token(10) }, db),
    ).toBe(0);
  });
});

describe('pruneDeviceTokens', () => {
  test('removes a dead token across every user', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userA = insertUser(handle.db);
    const userB = insertUser(handle.db);

    for (const userId of [userA, userB]) {
      await registerDeviceToken(
        {
          userId: toObjectId(userId),
          deviceToken: token(11),
          platform: 'ios',
          environment: 'production',
        },
        db,
      );
    }
    expect(await pruneDeviceTokens([token(11)], db)).toBe(2);
    expect(await listAllDeviceTokens(db)).toHaveLength(0);
  });

  test('prunes a burst of tokens in one statement, ignoring unknown ones', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const userId = insertUser(handle.db);

    for (const seed of [12, 13]) {
      await registerDeviceToken(
        {
          userId: toObjectId(userId),
          deviceToken: token(seed),
          platform: 'ios',
          environment: 'production',
        },
        db,
      );
    }
    expect(await pruneDeviceTokens([token(12), token(13), token(99)], db)).toBe(2);
    expect(await listDeviceTokensForUser(toObjectId(userId), db)).toHaveLength(0);
  });

  test('skips the round trip on an empty list', async () => {
    using handle = await createTestDatabase();
    expect(await pruneDeviceTokens([], testSqliteDb(handle.db))).toBe(0);
  });
});
