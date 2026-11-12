import { beforeEach, afterEach, expect, spyOn, test } from 'bun:test';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { storeChallenge } from '../db/repos/auth.challenges.repo.ts';
import { runAuthExpiryPass } from './auth-expiry-sweep.ts';

let live: Awaited<ReturnType<typeof createLiveTestDatabase>>;

async function challenge(name: string, expired: boolean): Promise<void> {
  await storeChallenge({
    challenge: name,
    purpose: 'authenticate',
    user_id: null,
    email: null,
    invite_code: null,
  });
  if (expired)
    await live.handle.write('UPDATE challenges SET expires_at = ? WHERE challenge = ?', [
      '2020-01-01T00:00:00.000Z',
      name,
    ]);
}

const remaining = () => live.db.query('SELECT challenge FROM challenges ORDER BY challenge').all();

beforeEach(async () => {
  live = await createLiveTestDatabase('file');
});

afterEach(() => {
  live.close();
});

test('a pass removes expired rows and keeps live ceremonies', async () => {
  await challenge('old', true);
  await challenge('live', false);

  await runAuthExpiryPass();

  expect(remaining()).toEqual([{ challenge: 'live' }]);
});

test('a table that fails is left for the next pass, which removes its rows', async () => {
  await challenge('retry', true);
  const writeSpy = spyOn(live.handle, 'write').mockRejectedValueOnce(new Error('database busy'));
  try {
    await runAuthExpiryPass();
    expect(remaining()).toHaveLength(1);
  } finally {
    writeSpy.mockRestore();
  }

  await runAuthExpiryPass();

  expect(remaining()).toHaveLength(0);
});
