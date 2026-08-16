/**
 * Per-suite scoping of the environment overrides Mongo-backed tests rely on.
 *
 * Bun evaluates every module body during the import phase, before any test
 * runs. A suite that assigns `process.env.MAPLE_MONGO_DB` at module scope
 * therefore renames the database for the whole process at import time: when
 * several suites run in one process the last import wins, every other suite's
 * `getDb()` connects to that suite's database, and a teardown can drop a
 * database another suite is still using. That is the #2783 flake class.
 *
 * Capturing the previous value at module scope is the same bug wearing a
 * disguise: two suites that both override a variable capture each other's
 * override as their "prior", and then faithfully restore the wrong value
 * process-wide when they finish.
 *
 * `getDb()` re-reads the env on every call (see `db/client.ts`), so setting it
 * inside `beforeAll` is sufficient — and capturing/restoring in the hooks keeps
 * an override live only while the suite that owns it is running.
 */

import { beforeAll, afterAll } from 'bun:test';

/**
 * Override `process.env[name]` for the duration of this suite, restoring
 * whatever was there before (including "nothing") on the way out.
 *
 * Call it at module scope, before the suite registers any other hook: bun runs
 * root-level `beforeAll` hooks in registration order, so the value has to be
 * claimed by the first one for a later hook to see it.
 *
 * The mirror image applies to teardown: the restore is registered first, so it
 * runs BEFORE the suite's own `afterAll`. Teardown must not re-read the
 * variable to decide what to clean up — a suite that drops its database has to
 * capture the `Db` handle in `beforeAll` and drop that, because by teardown
 * `getDb()` answers with the default database again.
 */
export function withTestEnv(name: string, value: string): void {
  let prev: string | undefined;

  beforeAll(() => {
    prev = process.env[name];
    process.env[name] = value;
  });

  afterAll(() => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  });
}

/**
 * Point `getDb()` at `testDb` for the duration of this suite, and hand the
 * name back so a suite that also needs it can name and claim its database in
 * one binding.
 */
export function withTestDb(testDb: string): string {
  withTestEnv('MAPLE_MONGO_DB', testDb);
  return testDb;
}
