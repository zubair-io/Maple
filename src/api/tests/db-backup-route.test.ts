import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { signAccessToken } from '../src/auth/tokens.ts';
import { dbBackupRoutes } from '../src/routes/db-backup.ts';
import { createLiveTestDatabase } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { DEFAULT_DB_BACKUP_POLICY } from '../src/cloudflare/backup-retain-config.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
const owner = await signAccessToken(
  {
    file_access: true,
    sub: '123456789012345678901234',
    email: 'owner@test.invalid',
    role: 'owner',
  },
  'x'.repeat(32),
);
const member = await signAccessToken(
  {
    file_access: true,
    sub: '123456789012345678901235',
    email: 'member@test.invalid',
    role: 'member',
  },
  'x'.repeat(32),
);
const app = new Elysia().use(dbBackupRoutes);
function request(method: string, token?: string, body?: unknown) {
  return app.handle(
    new Request(`http://localhost/api/admin/backup/db${method === 'PUT' ? '/config' : ''}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

test('all backup routes require an owner', async () => {
  using live = await createLiveTestDatabase();
  for (const method of ['GET', 'PUT', 'POST']) {
    expect(
      (await request(method, undefined, method === 'PUT' ? DEFAULT_DB_BACKUP_POLICY : undefined))
        .status,
    ).toBe(401);
    expect(
      (await request(method, member, method === 'PUT' ? DEFAULT_DB_BACKUP_POLICY : undefined))
        .status,
    ).toBe(403);
  }
});

test('policy round-trips and rejects invalid retention and missing bucket', async () => {
  using live = await createLiveTestDatabase();
  const policy = { ...DEFAULT_DB_BACKUP_POLICY, bucket: 'maple-private', daily: 9, enabled: true };
  expect((await request('PUT', owner, policy)).status).toBe(200);
  const settings = await (await request('GET', owner)).json();
  expect(settings.policy).toEqual(policy);
  expect(settings.running).toBe(false);
  expect(JSON.stringify(settings)).not.toContain('secret_access_key');
  expect((await request('PUT', owner, { ...policy, daily: -1 })).status).toBe(422);
  expect((await request('PUT', owner, { ...policy, monthly: 1.5 })).status).toBe(422);
  expect((await request('PUT', owner, { ...policy, hour: 24 })).status).toBe(422);
  expect((await request('PUT', owner, { ...policy, bucket: '' })).status).toBe(400);
  expect((await request('POST', owner)).status).toBe(400);
});
