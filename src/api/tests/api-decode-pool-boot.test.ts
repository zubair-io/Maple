import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBlankTestDatabase } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { runMigrations } from '../src/db/sqlite/migrate.ts';
import { ALL_MIGRATIONS } from '../src/db/sqlite/migrations/index.ts';

interface DecodePoolReport {
  ffi_workers: number;
  source: string;
  pool: { target: number };
}

/** Boots the real API on the database and returns what it reports about its own decode pool. */
async function bootedDecodePool(
  databasePath: string,
  directory: string,
  env: Record<string, string>,
): Promise<DecodePoolReport> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('MAPLE_')),
  );
  const child = Bun.spawn([Bun.which('bun')!, resolve('src/index.ts')], {
    env: {
      ...inherited,
      PORT: String(port),
      MAPLE_SQLITE_PATH: databasePath,
      MAPLE_INDEXER_AUTOSTART: '0',
      MAPLE_BACKUP_TMP: join(directory, 'chunks'),
      MAPLE_ROOTS: directory,
      MAPLE_DEV_AUTH: '1',
      MAPLE_JWT_SECRET: 'decode-pool-boot-test-secret-0123456789',
      LOG_LEVEL: 'warn',
      ...env,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  try {
    const deadline = Date.now() + 15_000;
    const connected = () =>
      fetch(`${base}/api/health`)
        .then((response) => response.json() as Promise<{ db_connected: boolean }>)
        .then((health) => health.db_connected)
        .catch(() => false);
    while (Date.now() < deadline && child.exitCode === null && !(await connected())) {
      await Bun.sleep(25);
    }
    const login = (await fetch(`${base}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then((response) => response.json())) as { access_token: string };
    const report = await fetch(`${base}/api/workers/performance`, {
      headers: { Authorization: `Bearer ${login.access_token}` },
    });
    expect(report.status).toBe(200);
    return (await report.json()) as DecodePoolReport;
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
}

async function decodePoolAfterBoot(
  savedWorkers: number | null,
  env: Record<string, string> = {},
): Promise<DecodePoolReport> {
  using database = createBlankTestDatabase('file');
  await runMigrations(database.migrationDb, ALL_MIGRATIONS);
  if (savedWorkers !== null) {
    database.db.run("INSERT INTO app_settings (id, doc) VALUES ('performance', ?)", [
      JSON.stringify({ config: { ffi_workers: savedWorkers, updated_at: 1 } }),
    ]);
  }
  const directory = await mkdtemp(join(tmpdir(), 'maple-decode-pool-boot-'));
  try {
    return await bootedDecodePool(database.path, directory, env);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('with nothing saved the request-serving process boots with two decode workers', async () => {
  const report = await decodePoolAfterBoot(null);
  expect(report).toMatchObject({ ffi_workers: 2, source: 'default', pool: { target: 2 } });
}, 40_000);

test('the request-serving process sizes its decode pool from the saved setting at boot', async () => {
  const report = await decodePoolAfterBoot(4);
  expect(report).toMatchObject({ ffi_workers: 4, source: 'db', pool: { target: 4 } });
}, 40_000);

test('the request-serving process sizes its decode pool from MAPLE_FFI_WORKERS at boot', async () => {
  const report = await decodePoolAfterBoot(null, { MAPLE_FFI_WORKERS: '3' });
  expect(report).toMatchObject({ ffi_workers: 3, source: 'env', pool: { target: 3 } });
}, 40_000);
