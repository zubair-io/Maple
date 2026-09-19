/**
 * "Seed a library, import it, then read rows back" — the setup the field-level
 * suites share.
 *
 * Each suite gets its own MongoDB database and its own SQLite file, so two
 * running in the same process cannot see each other's rows, and each closes the
 * database handle after every read: a suite that holds one open keeps a WAL
 * file alive past its own teardown.
 *
 * `state` is a live object rather than a pair of returned values because bun
 * evaluates a module body before any hook runs, so a suite destructuring
 * `client` at module scope would capture null forever. Reading
 * `fixture.state.client` inside a test sees what `setUp` put there.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { MongoClient } from 'mongodb';
import { closeImportSession, openImportSession, runImportOn } from './run.ts';
import type { ImportOptions } from './types.ts';
import { connectTestMongo, seedLibrary, TEST_MONGO_URI } from './seed.test-helpers.ts';
import type { SeedIds } from './seed-fixtures.test-helpers.ts';

/** What the hooks fill in; null until `setUp` has run, and null forever when
 * :27077 is not running, which is the signal every test uses to skip-pass. */
export interface FixtureState {
  client: MongoClient | null;
  ids: SeedIds | null;
}

/** A seeded-and-imported library, plus the two readers the suites use. */
export interface ImportedFixture {
  state: FixtureState;
  setUp: () => Promise<void>;
  tearDown: () => Promise<void>;
  one: <T>(sql: string, ...params: Array<string | number>) => T;
  all: <T>(sql: string, ...params: Array<string | number>) => T[];
}

/** Declares a fixture for one suite, against its own database name. */
export function importedFixture(dbName: string): ImportedFixture {
  const state: FixtureState = { client: null, ids: null };
  let sqlitePath = '';
  let workDir = '';

  const open = (): Database => new Database(sqlitePath, { readonly: true });

  return {
    state,
    one<T>(sql: string, ...params: Array<string | number>): T {
      const db = open();
      const row = db.query(sql).get(...params) as T;
      db.close();
      return row;
    },
    all<T>(sql: string, ...params: Array<string | number>): T[] {
      const db = open();
      const rows = db.query(sql).all(...params) as T[];
      db.close();
      return rows;
    },
    async setUp(): Promise<void> {
      state.client = await connectTestMongo();
      if (state.client === null) return;
      await state.client.db(dbName).dropDatabase();
      state.ids = await seedLibrary(state.client.db(dbName));

      workDir = mkdtempSync(join(tmpdir(), 'maple-import-fixture-'));
      sqlitePath = join(workDir, 'maple.db');
      const options: ImportOptions = {
        mongoUri: TEST_MONGO_URI,
        mongoDb: dbName,
        sqlitePath,
        batchSize: 10,
        changesWindow: 'all',
        verifySample: 10,
        restart: true,
      };
      const session = await openImportSession(options);
      try {
        await runImportOn(session, options);
      } finally {
        await closeImportSession(session);
      }
    },
    async tearDown(): Promise<void> {
      if (state.client !== null) {
        await state.client.db(dbName).dropDatabase();
        await state.client.close();
      }
      if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
    },
  };
}
