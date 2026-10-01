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

test('the real API sweeps at boot and restart, serves SQLite health, and drains on SIGTERM', async () => {
  using database = createBlankTestDatabase('file');
  await runMigrations(database.migrationDb, ALL_MIGRATIONS);
  database.db.run(
    "INSERT INTO challenges (id,challenge,purpose,expires_at) VALUES (?, 'live', 'authenticate', '2099-01-01T00:00:00.000Z')",
    ['1'.repeat(24)],
  );
  const directory = await mkdtemp(join(tmpdir(), 'maple-auth-expiry-boot-'));
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('MAPLE_')),
  );
  try {
    for (const name of ['first-boot', 'restart']) {
      database.db.run(
        "INSERT INTO challenges (id,challenge,purpose,expires_at) VALUES (?, ?, 'authenticate', '2020-01-01T00:00:00.000Z')",
        [name.padEnd(24, '0'), name],
      );
      const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
      const port = probe.port;
      probe.stop(true);
      const coveragePath = join(directory, `${name}-coverage.json`);
      const measured = '__coverage__' in globalThis;
      const process = Bun.spawn(
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
            MAPLE_SQLITE_PATH: database.path,
            MAPLE_INDEXER_AUTOSTART: '0',
            MAPLE_BACKUP_TMP: join(directory, 'chunks'),
            MAPLE_ROOTS: directory,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const stdout = new Response(process.stdout).text();
      const stderr = new Response(process.stderr).text();
      try {
        const deadline = Date.now() + 15_000;
        let health: { db_connected: boolean } | null = null;
        while (Date.now() < deadline && process.exitCode === null) {
          health = await fetch(`http://127.0.0.1:${port}/api/health`)
            .then((response) => response.json() as Promise<{ db_connected: boolean }>)
            .catch(() => null);
          if (health?.db_connected) break;
          await Bun.sleep(25);
        }
        expect(health?.db_connected).toBe(true);
        using observer = new Database(database.path, { readonly: true });
        expect(observer.query('SELECT challenge FROM challenges').all()).toEqual([
          { challenge: 'live' },
        ]);
        process.kill('SIGTERM');
        expect(await process.exited).toBe(0);
        expect(await stdout).toContain('Expired auth rows removed');
        expect(await stderr).not.toContain('error');
        if (measured) {
          mergeBootCoverage(JSON.parse(await readFile(coveragePath, 'utf8')) as CoverageMapData);
        }
      } finally {
        if (process.exitCode === null) process.kill('SIGKILL');
        await process.exited;
        await Promise.all([stdout, stderr]);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);
