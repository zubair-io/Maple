/**
 * Migration sentinel tests. Verify:
 *   - `recordMigration` writes a sentinel doc; `migrationApplied` reads it.
 *   - Duplicate `recordMigration` calls don't throw (E11000 swallowed).
 *
 * Skip-passes when Mongo is unreachable (same pattern as client.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, type Db } from 'mongodb';

const TEST_DB = `maple_test_migrations_core_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {
      /* ignore */
    }
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[migrations.core.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  for (const name of ['users', 'credentials', 'invites', 'refresh_tokens', 'challenges']) {
    await db.createCollection(name).catch(() => undefined);
  }
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('assets').deleteMany({});
  await db!.collection('migrations').deleteMany({});
  await db!.collection('folders').deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import('./client.ts');
  await closeDb();
});

describe('migrations module', () => {
  it('migrationApplied → false before recordMigration; true after', async () => {
    if (!mongoReachable) return;
    const { closeDb } = await import('./client.ts');
    await closeDb();
    const { migrationApplied, recordMigration } = await import('./migrations.ts');
    expect(await migrationApplied(db!, 'exif-captured-year-month-backfill')).toBe(false);
    await recordMigration(db!, 'exif-captured-year-month-backfill', 42);
    expect(await migrationApplied(db!, 'exif-captured-year-month-backfill')).toBe(true);
    // Stores rows + applied_at.
    const doc = await db!.collection('migrations').findOne({
      _id: 'exif-captured-year-month-backfill',
    } as Parameters<ReturnType<typeof db.collection>['findOne']>[0]);
    expect(doc).toBeDefined();
    expect((doc as { rows: number }).rows).toBe(42);
    expect((doc as { applied_at: Date }).applied_at).toBeInstanceOf(Date);
  });

  it("recordMigration is idempotent — duplicate calls don't throw", async () => {
    if (!mongoReachable) return;
    const { closeDb } = await import('./client.ts');
    await closeDb();
    const { recordMigration, migrationApplied } = await import('./migrations.ts');
    await recordMigration(db!, 'place-search-blob-backfill', 10);
    // Second call must not throw (E11000 duplicate key is swallowed —
    // it just means another boot got there first).
    await recordMigration(db!, 'place-search-blob-backfill', 99);
    expect(await migrationApplied(db!, 'place-search-blob-backfill')).toBe(true);
    // First write wins; second is a no-op.
    const doc = await db!.collection('migrations').findOne({
      _id: 'place-search-blob-backfill',
    } as Parameters<ReturnType<typeof db.collection>['findOne']>[0]);
    expect((doc as { rows: number }).rows).toBe(10);
  });
});
