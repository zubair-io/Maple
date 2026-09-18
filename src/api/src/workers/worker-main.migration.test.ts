/**
 * Only the API process migrates, and only before it serves (#3752).
 *
 * Both halves of that are structural rather than behavioural — they are
 * properties of which module calls what, in which order — so they are asserted
 * against the two entry points' source. A behavioural test would have to boot
 * two processes against one file and catch a race that, by construction,
 * happens only when the invariant is already broken.
 *
 * It is worth a test because the failure is silent and expensive. A worker that
 * migrated would be a second writer against a half-built database whose resume
 * checkpoints assume one; a worker spawned early would claim stages against a
 * library that is still filling up, and mark assets done that have no rows yet.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..');

function source(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

describe('the worker tier', () => {
  it('opens the database but never migrates it', () => {
    const workerMain = source('workers/worker-main.ts');

    // It needs its own connection — the pool is per-process.
    expect(workerMain).toContain('openSqlitePool');

    // And it must not reach for the cutover. Importing the path helper is
    // fine and expected; calling the migration is what is forbidden.
    expect(workerMain).not.toContain('migrateAtBoot');
  });
});

describe('the API process', () => {
  it('finishes the migration before it spawns the worker or listens', () => {
    const index = source('index.ts');

    const migration = index.indexOf('await startSqlite()');
    const spawn = index.indexOf('startWorkerSupervisor(');
    const listen = index.indexOf('server.listen(');

    expect(migration).toBeGreaterThan(-1);
    expect(spawn).toBeGreaterThan(migration);
    expect(listen).toBeGreaterThan(migration);
  });

  it('refuses to serve when the migration fails, rather than logging and continuing', () => {
    const index = source('index.ts');
    const startSqlite = index.slice(
      index.indexOf('async function startSqlite()'),
      index.indexOf('async function start()'),
    );

    // Every other boot phase logs and carries on. This one exits: an empty
    // library is indistinguishable from a deleted one to a File Provider
    // client, and it would act on the difference.
    expect(startSqlite).toContain('process.exit(1)');
  });
});
