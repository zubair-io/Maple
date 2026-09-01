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
import { MongoClient } from 'mongodb';

/**
 * Connect to the test Mongo, or return `null` when none is reachable — the
 * signal every Mongo-backed suite uses to skip-pass rather than fail on a
 * machine (or a CI job) without a database. Short timeouts so that verdict
 * arrives in a second and a half rather than at bun's test timeout.
 *
 * One copy, shared: each suite that rolled its own drifted on the timeouts
 * and on whether the half-open client was closed after a failed connect.
 *
 * `uri` lets a caller pass an explicitly-captured connection string instead
 * of reading `process.env.MAPLE_MONGO_URI` fresh — `withTestDb` below needs
 * this because by the time its drop runs, a suite-level `MAPLE_MONGO_URI`
 * override may already have been restored (see its comment).
 */
export async function tryConnectTestMongo(uri?: string): Promise<MongoClient | null> {
  // Read the env at connect time, not at module scope, when no explicit URI
  // is given. Bun evaluates every module body during the import phase,
  // before any hook runs, so a value captured up there is the one from
  // before any `beforeAll` that sets it — the same trap `withTestEnv` above
  // exists to avoid.
  const resolvedUri = uri ?? process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
  const client = new MongoClient(resolvedUri, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return client;
  } catch {
    try {
      await client.close();
    } catch {}
    return null;
  }
}

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
 * Point `getDb()` at `testDb` for the duration of this suite, hand the name
 * back so a suite that also needs it can name and claim its database in one
 * binding, AND register a generic `afterAll` that drops `testDb` when the
 * suite finishes.
 *
 * #2491: the per-file unique database naming (`maple_test_<name>_<pid>`) is
 * what keeps parallel and concurrent-agent runs from colliding — that stays.
 * What doesn't is depending on every suite to remember its own drop: on the
 * dev mongod this measured at 11,375 leaked test databases, because a suite
 * that never got a `dropDatabase()` call written (or whose own `afterAll`
 * never runs — a killed/timed-out process skips every `afterAll` in the
 * file, `withTestDb`'s included) leaves its database behind forever. Owning
 * the drop here means every suite gets it whether or not its own file
 * remembers, including ones that don't otherwise touch Mongo cleanup at all.
 *
 * Uses its OWN short-lived connection (`tryConnectTestMongo`), entirely
 * independent of whatever client a suite's own hooks manage — `dropDatabase`
 * is idempotent, so this is safe to run whether it fires before, after, or
 * instead of a suite's own (now-redundant, safe to leave as-is) drop. Skips
 * silently when Mongo is unreachable, matching the skip-pass convention
 * every Mongo-backed suite already follows — there is nothing to clean up
 * on a machine without a database.
 *
 * Captures `MAPLE_MONGO_URI` in its own `beforeAll` rather than letting the
 * drop's `tryConnectTestMongo()` re-read the env when it runs. A suite that
 * also overrides `MAPLE_MONGO_URI` (e.g. `withTestEnv('MAPLE_MONGO_URI', …)`
 * called before this, as `routes/pano.resolve.test.ts` does to point at its
 * own throwaway mongod) registers that override's restore-on-teardown
 * `afterAll` BEFORE this function's drop `afterAll` — and bun runs `afterAll`
 * hooks in registration order, so by the time the drop fires,
 * `MAPLE_MONGO_URI` has already been put back to whatever it was before the
 * suite ran. Reading it fresh at that point connects to the wrong Mongo (or
 * none at all) and silently fails to drop the suite's actual database.
 * Capturing during `beforeAll` — which runs while the override is still
 * live, since callers override `MAPLE_MONGO_URI` before calling `withTestDb`
 * — and reusing that value for the drop sidesteps the whole ordering trap.
 */
export function withTestDb(testDb: string): string {
  withTestEnv('MAPLE_MONGO_DB', testDb);

  let capturedUri: string | undefined;
  beforeAll(() => {
    capturedUri = process.env.MAPLE_MONGO_URI;
  });

  afterAll(async () => {
    const client = await tryConnectTestMongo(capturedUri);
    if (!client) return;
    try {
      await client.db(testDb).dropDatabase();
    } finally {
      await client.close();
    }
  });

  return testDb;
}
