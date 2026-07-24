import { describe, expect, test, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { refreshTokensCollection } from '../db/client.ts';
import {
  issueRefreshToken,
  rotateRefreshToken,
  listDeviceSessions,
  revokeDeviceSession,
} from './refresh_store.ts';

// (Reuse the same test-Mongo bootstrap as the existing refresh_store tests —
// src/api/tests/auth/refresh_store.test.ts — which relies on MAPLE_MONGO_URI
// already pointing at a live test Mongo and just clears the collection.)
beforeEach(async () => {
  const c = await refreshTokensCollection();
  await c.deleteMany({});
});

describe('device-session platform marker', () => {
  test('issue stamps platform and returns the family id', async () => {
    const userId = new ObjectId();
    const issued = await issueRefreshToken(userId, 'Living Room', { platform: 'tvos' });
    expect(issued.familyId).toBeInstanceOf(ObjectId);
    const row = await (await refreshTokensCollection()).findOne({ family_id: issued.familyId });
    expect(row?.platform).toBe('tvos');
    expect(row?.device_label).toBe('Living Room');
  });

  test('rotation propagates platform to the successor', async () => {
    const userId = new ObjectId();
    const issued = await issueRefreshToken(userId, 'Living Room', { platform: 'tvos' });
    const rotated = await rotateRefreshToken(issued.raw);
    const c = await refreshTokensCollection();
    const successor = await c.findOne({ family_id: issued.familyId, revoked_at: null });
    expect(successor?.platform).toBe('tvos');
    expect(rotated.familyId.equals(issued.familyId)).toBe(true);
  });

  test('plain logins have no platform', async () => {
    const userId = new ObjectId();
    const issued = await issueRefreshToken(userId, 'Safari on Mac');
    const row = await (await refreshTokensCollection()).findOne({ family_id: issued.familyId });
    expect(row?.platform).toBeUndefined();
  });
});

describe('device-session list/revoke', () => {
  test('lists only live platform-marked families for the user', async () => {
    const userId = new ObjectId();
    const tv = await issueRefreshToken(userId, 'Living Room', { platform: 'tvos' });
    await issueRefreshToken(userId, 'Safari on Mac'); // plain login — excluded
    await issueRefreshToken(new ObjectId(), 'Bedroom', { platform: 'tvos' }); // other user — excluded
    const sessions = await listDeviceSessions(userId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: tv.familyId.toHexString(),
      label: 'Living Room',
      platform: 'tvos',
    });
  });

  test('rotation updates last_used_at, not created_at', async () => {
    const userId = new ObjectId();
    const tv = await issueRefreshToken(userId, 'Living Room', { platform: 'tvos' });
    await rotateRefreshToken(tv.raw);
    const [s] = await listDeviceSessions(userId);
    expect(new Date(s.last_used_at).getTime()).toBeGreaterThanOrEqual(
      new Date(s.created_at).getTime(),
    );
  });

  test('revoke kills the family and it leaves the list', async () => {
    const userId = new ObjectId();
    const tv = await issueRefreshToken(userId, 'Living Room', { platform: 'tvos' });
    expect(await revokeDeviceSession(userId, tv.familyId)).toBe(true);
    expect(await listDeviceSessions(userId)).toHaveLength(0);
    await expect(rotateRefreshToken(tv.raw)).rejects.toThrow(); // family dead
  });

  test('revoke refuses other users and plain families', async () => {
    const userId = new ObjectId();
    const tv = await issueRefreshToken(userId, 'Living Room', { platform: 'tvos' });
    const plain = await issueRefreshToken(userId, 'Safari on Mac');
    expect(await revokeDeviceSession(new ObjectId(), tv.familyId)).toBe(false);
    expect(await revokeDeviceSession(userId, plain.familyId)).toBe(false);
  });
});
