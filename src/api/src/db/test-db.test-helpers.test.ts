/**
 * Self-test for `withTestDb`'s automatic drop (#2491).
 *
 * A leak-prevention helper is exactly the kind of thing that silently stops
 * working — its whole job only matters after the suite that uses it has
 * already finished, so a broken drop never fails the suite it was meant to
 * clean up after. This proves the drop actually happens by nesting a
 * throwaway suite that claims a database via `withTestDb`, then asserting
 * — from a sibling test that runs AFTER that nested suite's `afterAll` has
 * fired — that the database is gone from `listDatabases`.
 *
 * Real MongoDB, no mocks — skip-passes when unreachable, same convention
 * every other Mongo-backed suite in this repo follows.
 */

import { describe, test, expect } from 'bun:test';
import { tryConnectTestMongo, withTestDb, withTestEnv } from './test-db.test-helpers.ts';

describe('withTestDb — automatic drop (#2491)', () => {
  const dbName = `maple_test_withtestdb_selftest_${process.pid}`;

  describe('a suite that claims a database via withTestDb', () => {
    withTestDb(dbName);

    test('seeds a document so the database actually exists on disk', async () => {
      const client = await tryConnectTestMongo();
      if (!client) return; // skip-pass — no Mongo reachable
      try {
        await client.db(dbName).collection('probe').insertOne({ ok: true });
      } finally {
        await client.close();
      }
    });
  });

  // Runs after the nested describe above — including its `afterAll` hooks,
  // per bun's Jest-compatible nested-suite ordering — so this observes the
  // POST-teardown state.
  test('the database is dropped once that inner suite finishes', async () => {
    const client = await tryConnectTestMongo();
    if (!client) return; // skip-pass
    try {
      const { databases } = await client.db('admin').admin().listDatabases({ nameOnly: true });
      expect(databases.map((d) => d.name)).not.toContain(dbName);
    } finally {
      await client.close();
    }
  });
});

/**
 * Reproduces the exact shape `routes/pano.resolve.test.ts` uses: a suite
 * overrides `MAPLE_MONGO_URI` (to point at its own throwaway mongod) before
 * calling `withTestDb`. Bun runs `afterAll` hooks in registration order, so
 * that override's restore-to-prior `afterAll` fires BEFORE `withTestDb`'s
 * own drop `afterAll` — if the drop re-read `MAPLE_MONGO_URI` at that point
 * (instead of using the value captured in `beforeAll`, while the override
 * was still live), it would connect to whatever the URI falls back to, not
 * the suite's real test mongod, and silently fail to drop the database.
 *
 * The outer override below stands in for that fallback: an address nothing
 * listens on. If the drop ever regresses to reading the env fresh, this
 * fails closed — the seeded database survives past teardown — rather than
 * failing open the way a real, merely-different mongod would.
 */
describe('withTestDb — drop uses the URI captured before a suite-level override was restored (#2491 follow-up)', () => {
  const dbName = `maple_test_withtestdb_uri_capture_${process.pid}`;
  const realUri = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

  // Stands in for "the override has been restored": nothing listens here.
  withTestEnv('MAPLE_MONGO_URI', 'mongodb://127.0.0.1:1/');

  describe('a nested suite that overrides MAPLE_MONGO_URI back to the real test mongod', () => {
    withTestEnv('MAPLE_MONGO_URI', realUri);
    withTestDb(dbName);

    test('seeds a document so the database actually exists on disk', async () => {
      const client = await tryConnectTestMongo();
      if (!client) return; // skip-pass — no Mongo reachable
      try {
        await client.db(dbName).collection('probe').insertOne({ ok: true });
      } finally {
        await client.close();
      }
    });
  });

  // Runs after the nested suite's own teardown — including withTestDb's
  // drop and the nested withTestEnv's restore — but before the outer
  // withTestEnv's restore above, so MAPLE_MONGO_URI is back to the
  // unreachable stand-in here. Connecting explicitly with `realUri` (rather
  // than relying on the env, which would fail to connect at all right now)
  // confirms the drop itself landed on the real mongod, not a no-op against
  // the unreachable fallback.
  test('the database is dropped even though MAPLE_MONGO_URI has since been restored to something unreachable', async () => {
    const client = await tryConnectTestMongo(realUri);
    if (!client) return; // skip-pass
    try {
      const { databases } = await client.db('admin').admin().listDatabases({ nameOnly: true });
      expect(databases.map((d) => d.name)).not.toContain(dbName);
    } finally {
      await client.close();
    }
  });
});
