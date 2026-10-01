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
      for (let attempt = 0; attempt < 3; attempt += 1) {
        database.db.run(
          "INSERT INTO challenges (id,challenge,purpose,expires_at) VALUES (?, ?, 'authenticate', '2020-01-01T00:00:00.000Z') ON CONFLICT (id) DO UPDATE SET expires_at = excluded.expires_at",
          [name.padEnd(24, '0'), name],
        );
        const probe = Bun.serve({ port: 0, fetch: () => new Response() });
        const port = probe.port;
        // Hold the first candidate to prove a bind collision is retried. The
        // production server deliberately rejects PORT=0, so later candidates
        // are released before spawn and can still race with another process.
        if (attempt > 0) probe.stop(true);
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
        let listening = false;
        const stdout = (async () => {
          const decoder = new TextDecoder();
          let text = '';
          let pending = '';
          for await (const bytes of process.stdout) {
            const chunk = decoder.decode(bytes, { stream: true });
            text += chunk;
            pending += chunk;
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            if (lines.some((line) => line.includes('"msg":"HTTP listener ready"')))
              listening = true;
          }
          return text;
        })();
        let bindFailed = false;
        const stderr = (async () => {
          let text = '';
          const decoder = new TextDecoder();
          for await (const bytes of process.stderr) {
            text += decoder.decode(bytes, { stream: true });
            if (text.includes('EADDRINUSE')) bindFailed = true;
          }
          return text;
        })();
        try {
          const deadline = Date.now() + 15_000;
          let health: { db_connected: boolean } | null = null;
          while (Date.now() < deadline && process.exitCode === null && !bindFailed) {
            if (listening) {
              health = await fetch(`http://127.0.0.1:${port}/api/health`)
                .then((response) => response.json() as Promise<{ db_connected: boolean }>)
                .catch(() => null);
              if (health?.db_connected) break;
            }
            await Bun.sleep(25);
          }
          if (bindFailed && attempt < 2) continue;
          expect(health?.db_connected).toBe(true);
          expect(attempt).toBeGreaterThan(0);
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
          break;
        } catch (error) {
          if (process.exitCode === null) process.kill('SIGKILL');
          await process.exited;
          throw new Error(`${name} boot failed:\n${await stderr}\n${await stdout}`, {
            cause: error,
          });
        } finally {
          if (process.exitCode === null) process.kill(bindFailed ? 'SIGTERM' : 'SIGKILL');
          await process.exited;
          await Promise.all([stdout, stderr]);
          probe.stop(true);
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);
