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
import { tryConnectTestMongo, withTestDb } from './test-db.test-helpers.ts';

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
