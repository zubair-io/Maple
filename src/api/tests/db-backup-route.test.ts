import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { signAccessToken } from '../src/auth/tokens.ts';
import { dbBackupRoutes } from '../src/routes/db-backup.ts';
import { createLiveTestDatabase } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import {
  DEFAULT_DB_BACKUP_POLICY,
  saveDbBackupPolicy,
  saveDbBackupStatus,
} from '../src/cloudflare/backup-retain-config.ts';
import { saveCloudflareConfig } from '../src/cloudflare/cloudflare-config.repo.ts';
import { patchAppSettings } from '../src/db/repos/app-settings.repo.ts';
import {
  clearMaintenanceRun,
  pendingMaintenanceRuns,
} from '../src/workers/maintenance/run-now.repo.ts';

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

async function configureBackups(): Promise<void> {
  await saveCloudflareConfig({
    account_id: 'test',
    bucket: 'thumbs',
    access_key_id: 'key',
    secret_access_key: 'secret',
  });
  await saveDbBackupPolicy({ ...DEFAULT_DB_BACKUP_POLICY, bucket: 'maple-private' });
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

test('backing up now asks the worker tier for a forced run and reports it as running', async () => {
  using _live = await createLiveTestDatabase();
  await configureBackups();

  const response = await request('POST', owner);

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ accepted: true });
  expect(
    (await pendingMaintenanceRuns()).map(({ taskId, options }) => ({ taskId, options })),
  ).toEqual([{ taskId: 'db-backup', options: { force: true } }]);
  expect((await (await request('GET', owner)).json()).running).toBe(true);
  expect((await request('POST', owner)).status).toBe(409);
});

test('a backup whose heartbeat is recent blocks a new one and policy changes', async () => {
  using _live = await createLiveTestDatabase();
  await configureBackups();
  await saveDbBackupStatus({
    state: 'running',
    started_at: minutesAgo(20),
    heartbeat_at: minutesAgo(0),
  });

  expect((await (await request('GET', owner)).json()).running).toBe(true);
  expect((await request('POST', owner)).status).toBe(409);
  expect(
    (await request('PUT', owner, { ...DEFAULT_DB_BACKUP_POLICY, bucket: 'maple-private' })).status,
  ).toBe(409);
});

test('a running status whose heartbeat stopped does not block anything', async () => {
  using _live = await createLiveTestDatabase();
  await configureBackups();
  await saveDbBackupStatus({
    state: 'running',
    started_at: minutesAgo(60),
    heartbeat_at: minutesAgo(30),
  });

  expect((await (await request('GET', owner)).json()).running).toBe(false);
  expect(
    (await request('PUT', owner, { ...DEFAULT_DB_BACKUP_POLICY, bucket: 'maple-private' })).status,
  ).toBe(200);
  expect((await request('POST', owner)).status).toBe(202);
});

test('once the requested run has been handed over, the route follows the stored status', async () => {
  using _live = await createLiveTestDatabase();
  await configureBackups();
  await request('POST', owner);
  const [request_] = await pendingMaintenanceRuns();
  await clearMaintenanceRun(request_!);
  await saveDbBackupStatus({
    state: 'succeeded',
    started_at: minutesAgo(1),
    finished_at: minutesAgo(0),
  });

  expect((await (await request('GET', owner)).json()).running).toBe(false);
  expect((await request('POST', owner)).status).toBe(202);
});

test('a request the worker tier never picked up stops blocking after two minutes and is reported', async () => {
  using _live = await createLiveTestDatabase();
  await configureBackups();
  await patchAppSettings('maintenance', {
    'requests.db-backup': { requestedAt: minutesAgo(3), options: { force: true } },
  });

  const settings = await (await request('GET', owner)).json();
  expect(settings.running).toBe(false);
  expect(settings.request_error).toContain('was not picked up');

  expect((await request('POST', owner)).status).toBe(202);
  const [renewed] = await pendingMaintenanceRuns();
  expect(Date.parse(renewed!.requestedAt)).toBeGreaterThan(Date.now() - 60_000);
  const after = await (await request('GET', owner)).json();
  expect(after.running).toBe(true);
  expect(after.request_error).toBeUndefined();
});
