import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { storeChallenge } from '../db/repos/auth.challenges.repo.ts';
import { startAuthExpiryScheduler, stopAuthExpiryScheduler } from './auth-expiry-scheduler.ts';

const originalSetInterval = globalThis.setInterval;
let live: Awaited<ReturnType<typeof createLiveTestDatabase>>;
let intervalSpy: ReturnType<typeof spyOn<typeof globalThis, 'setInterval'>>;
let intervalTick: () => void;

async function expiredChallenge(name: string): Promise<void> {
  await storeChallenge({
    challenge: name,
    purpose: 'authenticate',
    user_id: null,
    email: null,
    invite_code: null,
  });
  await live.handle.write('UPDATE challenges SET expires_at = ? WHERE challenge = ?', [
    '2020-01-01T00:00:00.000Z',
    name,
  ]);
}

describe('auth expiry lifecycle', () => {
  beforeEach(async () => {
    live = await createLiveTestDatabase('file');
    intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((
      callback: () => void,
      delay?: number,
    ) => {
      intervalTick = callback;
      return originalSetInterval(callback, delay);
    }) as typeof globalThis.setInterval);
  });

  afterEach(async () => {
    await stopAuthExpiryScheduler();
    intervalSpy.mockRestore();
    live.close();
  });

  test('startup and subsequent ticks remove expired rows while retaining live ceremonies', async () => {
    await expiredChallenge('old');
    await storeChallenge({
      challenge: 'live',
      purpose: 'authenticate',
      user_id: null,
      email: null,
      invite_code: null,
    });
    await startAuthExpiryScheduler();
    expect(live.db.query('SELECT challenge FROM challenges').all()).toEqual([
      { challenge: 'live' },
    ]);

    await expiredChallenge('next');
    intervalTick();
    await stopAuthExpiryScheduler();
    expect(live.db.query('SELECT challenge FROM challenges').all()).toEqual([
      { challenge: 'live' },
    ]);
    await startAuthExpiryScheduler();
    await startAuthExpiryScheduler();
    expect(intervalSpy).toHaveBeenCalledTimes(2);
  });

  test('overlapping ticks share one pass and shutdown waits for its writes', async () => {
    await startAuthExpiryScheduler();
    await expiredChallenge('delayed');
    const write = live.handle.write.bind(live.handle);
    const gate = Promise.withResolvers<void>();
    const writeSpy = spyOn(live.handle, 'write').mockImplementation(async (sql, params) => {
      await gate.promise;
      return write(sql, params);
    });
    try {
      intervalTick();
      intervalTick();
      expect(writeSpy).toHaveBeenCalledTimes(1);
      let stopped = false;
      const stopping = stopAuthExpiryScheduler().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(live.db.query('SELECT challenge FROM challenges').all()).toHaveLength(1);
      gate.resolve();
      await stopping;
      expect(live.db.query('SELECT challenge FROM challenges').all()).toHaveLength(0);
      expect(writeSpy).toHaveBeenCalledTimes(6);
      intervalTick();
      expect(writeSpy).toHaveBeenCalledTimes(6);
    } finally {
      gate.resolve();
      await stopAuthExpiryScheduler();
      writeSpy.mockRestore();
    }
  });

  test('a failed table is retried on the next tick without discarding live rows', async () => {
    await expiredChallenge('retry');
    const writeSpy = spyOn(live.handle, 'write').mockRejectedValueOnce(new Error('database busy'));
    try {
      await startAuthExpiryScheduler();
      expect(live.db.query('SELECT challenge FROM challenges').all()).toHaveLength(1);
      intervalTick();
      await stopAuthExpiryScheduler();
      expect(live.db.query('SELECT challenge FROM challenges').all()).toHaveLength(0);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
