import { describe, expect, test, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { refreshTokensCollection } from '../db/client.ts';
import { issueRefreshToken, rotateRefreshToken } from './refresh_store.ts';

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
    const issued = await issueRefreshToken(userId, 'Living Room', undefined, 'tvos');
    expect(issued.familyId).toBeInstanceOf(ObjectId);
    const row = await (await refreshTokensCollection()).findOne({ family_id: issued.familyId });
    expect(row?.platform).toBe('tvos');
    expect(row?.device_label).toBe('Living Room');
  });

  test('rotation propagates platform to the successor', async () => {
    const userId = new ObjectId();
    const issued = await issueRefreshToken(userId, 'Living Room', undefined, 'tvos');
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
