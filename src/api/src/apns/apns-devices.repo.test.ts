import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ObjectId } from 'mongodb';
import { closeDb, getDb, isDbConnected } from '../db/client.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';
import {
  listAllDeviceTokens,
  listDeviceTokensForUser,
  normalizeDeviceToken,
  pruneDeviceTokens,
  registerDeviceToken,
  unregisterDeviceToken,
} from './apns-devices.repo.ts';

describe('normalizeDeviceToken', () => {
  const VALID = 'a1'.repeat(32); // 64 lowercase hex chars

  it('accepts a valid lowercase hex token unchanged', () => {
    expect(normalizeDeviceToken(VALID)).toBe(VALID);
  });

  it('lowercases and trims surrounding whitespace', () => {
    expect(normalizeDeviceToken(`  ${VALID.toUpperCase()}\n`)).toBe(VALID);
  });

  it('rejects a token that is too short', () => {
    expect(normalizeDeviceToken('a1b2')).toBeNull();
  });

  it('rejects non-hex characters', () => {
    expect(normalizeDeviceToken('z'.repeat(64))).toBeNull();
    expect(normalizeDeviceToken('not-a-real-token')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(normalizeDeviceToken('')).toBeNull();
    expect(normalizeDeviceToken('   ')).toBeNull();
  });
});

withTestDb(`maple_test_apns_devices_repo_${process.pid}`);

let mongoReachable = false;

beforeAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  try {
    await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
    return;
  }
  const db = await getDb();
  await db.collection('apns_device_tokens').deleteMany({});
});

afterAll(async () => {
  const db = await getDb().catch(() => null);
  if (db) await db.dropDatabase();
  await closeDb();
});

/** A distinct, realistically-shaped (64 lowercase hex chars) fake device
 * token per call — production tokens are always this exact shape now
 * that the route layer validates/normalizes against it (Copilot review
 * #3214), so repo-level tests use the same shape for consistency even
 * though the repo functions themselves don't validate format. */
function tok(n: number): string {
  return n.toString(16).padStart(2, '0').repeat(32);
}

describe('apns-devices.repo', () => {
  it('registers a device and lists it back for its user', async () => {
    if (!mongoReachable) return;
    const userId = new ObjectId();
    await registerDeviceToken({
      userId,
      deviceToken: tok(1),
      platform: 'ios',
      environment: 'sandbox',
    });
    const devices = await listDeviceTokensForUser(userId);
    expect(devices).toHaveLength(1);
    expect(devices[0]!.device_token).toBe(tok(1));
    expect(devices[0]!.environment).toBe('sandbox');
  });

  it('re-registering the same (user, device) upserts rather than duplicating', async () => {
    if (!mongoReachable) return;
    const userId = new ObjectId();
    await registerDeviceToken({
      userId,
      deviceToken: tok(2),
      platform: 'ios',
      environment: 'sandbox',
    });
    await registerDeviceToken({
      userId,
      deviceToken: tok(2),
      platform: 'ios',
      environment: 'production', // token moved from a dev build to TestFlight
    });
    const devices = await listDeviceTokensForUser(userId);
    expect(devices).toHaveLength(1);
    expect(devices[0]!.environment).toBe('production');
  });

  it('one user can register more than one device', async () => {
    if (!mongoReachable) return;
    const userId = new ObjectId();
    await registerDeviceToken({
      userId,
      deviceToken: tok(3),
      platform: 'macos',
      environment: 'production',
    });
    await registerDeviceToken({
      userId,
      deviceToken: tok(4),
      platform: 'ios',
      environment: 'production',
    });
    expect(await listDeviceTokensForUser(userId)).toHaveLength(2);
    expect(await listAllDeviceTokens()).toHaveLength(2);
  });

  it('unregisterDeviceToken removes the (user, device) pairing', async () => {
    if (!mongoReachable) return;
    const userId = new ObjectId();
    await registerDeviceToken({
      userId,
      deviceToken: tok(5),
      platform: 'ios',
      environment: 'sandbox',
    });
    const removed = await unregisterDeviceToken({ userId, deviceToken: tok(5) });
    expect(removed).toBe(1);
    expect(await listDeviceTokensForUser(userId)).toHaveLength(0);
  });

  it('unregisterDeviceToken is a no-op for a device that was never registered', async () => {
    if (!mongoReachable) return;
    const removed = await unregisterDeviceToken({ userId: new ObjectId(), deviceToken: tok(6) });
    expect(removed).toBe(0);
  });

  it('pruneDeviceTokens removes a dead token across every user', async () => {
    if (!mongoReachable) return;
    const userA = new ObjectId();
    const userB = new ObjectId();
    await registerDeviceToken({
      userId: userA,
      deviceToken: tok(7),
      platform: 'ios',
      environment: 'production',
    });
    await registerDeviceToken({
      userId: userB,
      deviceToken: tok(7),
      platform: 'ios',
      environment: 'production',
    });
    const removed = await pruneDeviceTokens([tok(7)]);
    expect(removed).toBe(2);
    expect(await listDeviceTokensForUser(userA)).toHaveLength(0);
    expect(await listDeviceTokensForUser(userB)).toHaveLength(0);
  });

  it('pruneDeviceTokens batches multiple tokens into one deleteMany', async () => {
    if (!mongoReachable) return;
    const userId = new ObjectId();
    await registerDeviceToken({
      userId,
      deviceToken: tok(8),
      platform: 'ios',
      environment: 'production',
    });
    await registerDeviceToken({
      userId,
      deviceToken: tok(9),
      platform: 'ios',
      environment: 'production',
    });
    const removed = await pruneDeviceTokens([tok(8), tok(9), tok(99)]);
    expect(removed).toBe(2);
    expect(await listDeviceTokensForUser(userId)).toHaveLength(0);
  });

  it('pruneDeviceTokens is a no-op on an empty array', async () => {
    if (!mongoReachable) return;
    expect(await pruneDeviceTokens([])).toBe(0);
  });

  it('listAllDeviceTokens returns devices across every user', async () => {
    if (!mongoReachable) return;
    await registerDeviceToken({
      userId: new ObjectId(),
      deviceToken: tok(10),
      platform: 'ios',
      environment: 'sandbox',
    });
    await registerDeviceToken({
      userId: new ObjectId(),
      deviceToken: tok(11),
      platform: 'macos',
      environment: 'production',
    });
    const all = await listAllDeviceTokens();
    expect(all.map((d) => d.device_token).sort()).toEqual([tok(10), tok(11)]);
  });
});
