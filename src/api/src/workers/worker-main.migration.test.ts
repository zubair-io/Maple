/**
 * Only the API process prepares the schema, and only before it serves.
 *
 * Both halves of that are structural rather than behavioural — they are
 * properties of which module calls what, in which order — so they are asserted
 * against the two entry points' source. A behavioural test would have to boot
 * two processes against one file and catch a race that, by construction,
 * happens only when the invariant is already broken.
 *
 * It is worth a test because the failure is silent and expensive. A worker
 * spawned before the schema is current would claim stages against a database
 * missing the columns its writeback names, and fail every one of them on a
 * library that is otherwise healthy.
 *
 * The migration runner itself tolerates two processes racing — it takes the
 * write lock and re-checks the sentinel inside it — so this is not a safety
 * net against corruption. It is a statement about who owns the boot: one
 * process decides the schema is ready, and the tier it spawns inherits that
 * decision rather than re-deciding it.
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

    // And it must not reach for the schema gate. Importing the path helper is
    // fine and expected; running the migrations is what is forbidden.
    expect(workerMain).not.toContain('ensureSchemaAtBoot');
    expect(workerMain).not.toContain('runMigrations');

    // One connection, and only one. The tier has no second store to reach and
    // no index set to ensure — the schema is the migration's output — so either
    // of these reappearing here is a second database being opened, not a
    // detail.
    expect(workerMain).not.toContain('getDb');
    expect(workerMain).not.toContain('ensureIndexes');
  });
});

describe('the API process', () => {
  it('finishes preparing the schema before it spawns the worker or listens', () => {
    const index = source('index.ts');

    const schema = index.indexOf('await startSqlite()');
    const spawn = index.indexOf('startWorkerSupervisor(');
    const listen = index.indexOf('server.listen(');

    expect(schema).toBeGreaterThan(-1);
    expect(spawn).toBeGreaterThan(schema);
    expect(listen).toBeGreaterThan(schema);
  });

  it('refuses to serve when the schema cannot be prepared, rather than logging and continuing', () => {
    const index = source('index.ts');
    const startSqlite = index.slice(
      index.indexOf('async function startSqlite()'),
      index.indexOf('async function start()'),
    );

    // Every other boot phase logs and carries on. This one exits: a migration
    // that failed leaves the schema in a shape the code above it does not
    // expect, and every write from then on is into that shape.
    expect(startSqlite).toContain('process.exit(1)');
  });
});
