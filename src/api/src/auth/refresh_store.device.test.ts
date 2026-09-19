/**
 * The device-session panel reaches the SQLite store through
 * `auth/refresh_store.ts` (#3787).
 *
 * The listing and revoke rules — only platform-marked families, ownership
 * checks, a dead family dropping off — are covered against the repository in
 * `db/sqlite/repos/auth.sessions.repo.test.ts`. What is left here is the seam
 * `routes/auth-device-sessions.ts` sits on: the panel's two functions are
 * re-exported from the refresh module alongside the token operations, and the
 * `platform` marker that decides what a device session even is survives a
 * rotation.
 */

import { describe, expect, test } from 'bun:test';
import {
  issueRefreshToken,
  listDeviceSessions,
  revokeDeviceSession,
  rotateRefreshToken,
} from './refresh_store.ts';
import { insertUser } from '../db/sqlite/repos/auth.users.repo.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

async function seedUser(live: LiveTestDatabase, email = 'owner@maple.test') {
  return await insertUser(
    { email, role: 'owner', created_at: new Date().toISOString(), last_seen_at: null },
    live.handle,
  );
}

describe('device sessions through the refresh module', () => {
  test('a paired device is listed, an ordinary login is not', async () => {
    using live = await createLiveTestDatabase();
    const userId = await seedUser(live);
    const tv = await issueRefreshToken(userId, 'Living Room', { platform: 'tvos' });
    await issueRefreshToken(userId, 'Safari on Mac'); // no platform marker
    await issueRefreshToken(await seedUser(live, 'other@maple.test'), 'Bedroom', {
      platform: 'tvos',
    });

    const sessions = await listDeviceSessions(userId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: tv.familyId.toHexString(),
      label: 'Living Room',
      platform: 'tvos',
    });
  });

  test('the platform marker survives a rotation, and rotation moves last_used_at', async () => {
    using live = await createLiveTestDatabase();
    const userId = await seedUser(live);
    const tv = await issueRefreshToken(userId, 'Living Room', { platform: 'tvos' });
    const rotated = await rotateRefreshToken(tv.raw);
    expect(rotated.familyId.toHexString()).toBe(tv.familyId.toHexString());

    const [session] = await listDeviceSessions(userId);
    expect(session?.platform).toBe('tvos');
    expect(new Date(session!.last_used_at).getTime()).toBeGreaterThanOrEqual(
      new Date(session!.created_at).getTime(),
    );
  });

  test('signing a device out takes it off the list and ends its lineage', async () => {
    using live = await createLiveTestDatabase();
    const userId = await seedUser(live);
    const tv = await issueRefreshToken(userId, 'Living Room', { platform: 'tvos' });

    expect(await revokeDeviceSession(userId, tv.familyId)).toBe(true);
    expect(await listDeviceSessions(userId)).toHaveLength(0);
    await expect(rotateRefreshToken(tv.raw)).rejects.toThrow();
  });
});
