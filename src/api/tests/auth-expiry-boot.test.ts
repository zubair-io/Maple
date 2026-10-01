import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import type { CoverageMapData } from 'istanbul-lib-coverage';
import { createBlankTestDatabase } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { runMigrations } from '../src/db/sqlite/migrate.ts';
import { ALL_MIGRATIONS } from '../src/db/sqlite/migrations/index.ts';

function mergeBootCoverage(child: CoverageMapData): void {
  const parent = (globalThis as typeof globalThis & { __coverage__?: CoverageMapData })
    .__coverage__;
  if (!parent) return;
  for (const [path, counters] of Object.entries(child)) {
    const existing = parent[path];
    if (!existing) {
      parent[path] = counters;
      continue;
    }
    // Both processes load the same pre-instrumented files. Retain the parent's
    // counter objects: executing modules still hold references to them.
    expect(existing.fnMap).toEqual(counters.fnMap);
    for (const key of Object.keys(counters.f)) existing.f[key]! += counters.f[key]!;
    for (const key of Object.keys(counters.s)) existing.s[key]! += counters.s[key]!;
    for (const key of Object.keys(counters.b)) {
      counters.b[key]!.forEach((count, index) => {
        existing.b[key]![index]! += count;
      });
    }
  }
}

function captureBootOutput(stream: ReadableStream<Uint8Array>) {
  let text = '';
  const done = (async () => {
    const decoder = new TextDecoder();
    for await (const bytes of stream) text += decoder.decode(bytes, { stream: true });
    return text;
  })();
  return {
    get text() {
      return text;
    },
    done,
  };
}

async function waitForListener(
  child: { readonly exitCode: number | null },
  port: number,
  stdout: ReturnType<typeof captureBootOutput>,
  stderr: ReturnType<typeof captureBootOutput>,
): Promise<'ready' | 'bind-failed' | 'stopped'> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (stderr.text.includes('EADDRINUSE')) return 'bind-failed';
    if (stdout.text.includes('"msg":"HTTP listener ready"')) {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`)
        .then((response) => response.json() as Promise<{ db_connected: boolean }>)
        .catch(() => null);
      if (health?.db_connected) return 'ready';
    }
    await Bun.sleep(25);
  }
  return stderr.text.includes('EADDRINUSE') ? 'bind-failed' : 'stopped';
}

async function stopBootChild(
  child: {
    readonly exitCode: number | null;
    readonly exited: Promise<number>;
    kill: (signal: NodeJS.Signals) => void;
  },
  signal: 'SIGTERM' | 'SIGKILL',
): Promise<void> {
  if (child.exitCode === null) child.kill(signal);
  await child.exited;
}

async function runBoot(
  database: Database,
  databasePath: string,
  directory: string,
  name: string,
): Promise<void> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('MAPLE_')),
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    database.run(
      "INSERT INTO challenges (id,challenge,purpose,expires_at) VALUES (?, ?, 'authenticate', '2020-01-01T00:00:00.000Z') ON CONFLICT (id) DO UPDATE SET expires_at = excluded.expires_at",
      [name.padEnd(24, '0'), name],
    );
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port!;
    // Force the first collision, then retry actual bind failures. PORT=0
    // selects 3000 under the existing production port-validation contract.
    if (attempt > 0) probe.stop(true);
    const coveragePath = join(directory, `${name}-coverage.json`);
    const measured = '__coverage__' in globalThis;
    const child = Bun.spawn(
      [
        Bun.which('bun')!,
        ...(measured ? ['--preload', resolve('tests/coverage.child.preload.ts')] : []),
        resolve('src/index.ts'),
        coveragePath,
      ],
      {
        env: {
          ...inherited,
          NODE_ENV: 'production',
          PORT: String(port),
          MAPLE_SQLITE_PATH: databasePath,
          MAPLE_INDEXER_AUTOSTART: '0',
          MAPLE_BACKUP_TMP: join(directory, 'chunks'),
          MAPLE_ROOTS: directory,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const stdout = captureBootOutput(child.stdout);
    const stderr = captureBootOutput(child.stderr);
    let bindFailed = false;
    try {
      const status = await waitForListener(child, port, stdout, stderr);
      bindFailed = status === 'bind-failed';
      if (bindFailed && attempt < 2) continue;
      expect(status).toBe('ready');
      expect(attempt).toBeGreaterThan(0);
      using observer = new Database(databasePath, { readonly: true });
      expect(observer.query('SELECT challenge FROM challenges').all()).toEqual([
        { challenge: 'live' },
      ]);
      child.kill('SIGTERM');
      expect(await child.exited).toBe(0);
      expect(await stdout.done).toContain('Expired auth rows removed');
      expect(await stderr.done).not.toContain('error');
      if (measured)
        mergeBootCoverage(JSON.parse(await readFile(coveragePath, 'utf8')) as CoverageMapData);
      return;
    } catch (error) {
      await stopBootChild(child, 'SIGKILL');
      throw new Error(`${name} boot failed:\n${await stderr.done}\n${await stdout.done}`, {
        cause: error,
      });
    } finally {
      await stopBootChild(child, bindFailed ? 'SIGTERM' : 'SIGKILL');
      await Promise.all([stdout.done, stderr.done]);
      probe.stop(true);
    }
  }
}

test('the real API sweeps at boot and restart, serves SQLite health, and drains on SIGTERM', async () => {
  using database = createBlankTestDatabase('file');
  await runMigrations(database.migrationDb, ALL_MIGRATIONS);
  database.db.run(
    "INSERT INTO challenges (id,challenge,purpose,expires_at) VALUES (?, 'live', 'authenticate', '2099-01-01T00:00:00.000Z')",
    ['1'.repeat(24)],
  );
  const directory = await mkdtemp(join(tmpdir(), 'maple-auth-expiry-boot-'));
  try {
    for (const name of ['first-boot', 'restart'])
      await runBoot(database.db, database.path, directory, name);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);
