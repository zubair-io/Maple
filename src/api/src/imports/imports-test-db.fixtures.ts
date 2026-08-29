/**
 * Shared Mongo scaffolding for the imports integration suites.
 *
 * `repo.test.ts` and `retry.test.ts` both need the same thing: a real Mongo
 * connection that skip-passes when none is reachable, a scratch database
 * cleared between cases, and a throwaway `ImportFileEntry`. Keeping one copy
 * means a change to the collection set or the skip convention can't fix one
 * suite and leave the other asserting against stale scaffolding.
 *
 * Named `.fixtures.ts` so bun's `*.test.ts` glob doesn't run it as a suite —
 * mirrors `workers/stages/describe.fixtures.ts`.
 */

import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { tryConnectTestMongo, withTestDb } from '../db/test-db.test-helpers.ts';
import type { ImportFileEntry } from '../db/schema.ts';

/** Collections every imports suite writes to and must clear between cases. */
const SCRATCH_COLLECTIONS = ['imports', 'import_files', 'assets'];

/** A throwaway pending file entry destined for `2024/03/<src>`. */
export function file(src: string): ImportFileEntry {
  return {
    src,
    dest: `2024/03/${src}`,
    size: 1,
    mtime: 0,
    kind: 'image',
    state: 'pending',
    error: null,
  };
}

export interface ImportsTestDb {
  /** False when no Mongo is reachable — every case returns early (skip-pass). */
  readonly reachable: boolean;
  /** Scratch database name. Exposed so a suite can assert that the code
   * under test is pointed at it (see the guard case in `repo.test.ts`). */
  readonly dbName: string;
  /** The scratch database. Only valid while `reachable`. */
  readonly db: Db;
  /** Stable library identity for the suite's fixtures. */
  readonly lib: { id: ObjectId; root: string };
}

/**
 * Register the connect / clear / teardown hooks for one suite and hand back a
 * live view of the scratch DB. Call at module scope, before `describe`.
 */
export function useImportsTestDb(dbName: string, label: string): ImportsTestDb {
  let mongo: MongoClient | null = null;
  let reachable = false;
  let db: Db | null = null;
  const lib = { id: new ObjectId(), root: '/srv/lib' };

  // FIRST, so the `getDb()` inside the code under test resolves to this
  // suite's scratch database. Without it the repo functions write to the
  // default database while the assertions below read the scratch one, and
  // every case fails on a machine that actually has Mongo. Bun runs
  // root-level `beforeAll` hooks in registration order, so this has to be
  // claimed before the hook below runs.
  withTestDb(dbName);

  beforeAll(async () => {
    mongo = await tryConnectTestMongo();
    reachable = mongo !== null;
    if (!reachable) {
      console.log(`[${label}] skipping: MongoDB unreachable`);
      return;
    }
    db = mongo!.db(dbName);
    await db.dropDatabase();
    const { closeDb } = await import('../db/client.ts');
    await closeDb();
  });

  beforeEach(async () => {
    if (!reachable) return;
    for (const name of SCRATCH_COLLECTIONS) await db!.collection(name).deleteMany({});
  });

  afterAll(async () => {
    if (mongo) {
      try {
        await mongo.db(dbName).dropDatabase();
      } catch {}
      try {
        await mongo.close();
      } catch {}
    }
    const { closeDb } = await import('../db/client.ts');
    await closeDb();
  });

  return {
    dbName,
    get reachable() {
      return reachable;
    },
    get db() {
      return db!;
    },
    lib,
  };
}
