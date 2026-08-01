/**
 * First-boot index initialization against a real, empty MongoDB database.
 *
 * Keep this separate from client.test.ts: that suite historically pre-created
 * auth collections, which hid the NamespaceNotFound failure this guards.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MongoClient, type Collection, type Db, type IndexDescriptionInfo } from 'mongodb';

const TEST_DB = `maple_test_client_pristine_${process.pid}`;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let db: Db | null = null;
let originalMongoDb: string | undefined;
let mongoDbOverridden = false;

async function connect(): Promise<MongoClient | null> {
  const client = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return client;
  } catch {
    await client.close().catch(() => undefined);
    return null;
  }
}

async function indexesFor(collection: Collection): Promise<IndexDescriptionInfo[]> {
  return collection.indexes();
}

function named(indexes: IndexDescriptionInfo[], name: string): IndexDescriptionInfo {
  const index = indexes.find((candidate) => candidate.name === name);
  expect(index).toBeDefined();
  if (!index) throw new Error(`Missing expected index: ${name}`);
  return index;
}

beforeAll(async () => {
  originalMongoDb = process.env.MAPLE_MONGO_DB;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  mongoDbOverridden = true;

  mongo = await connect();
  if (!mongo) {
    console.log('[client.pristine.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo.db(TEST_DB);
  await db.dropDatabase();
});

afterAll(async () => {
  try {
    const { closeDb } = await import('./client.ts');
    await closeDb();
    if (mongo) {
      await mongo.db(TEST_DB).dropDatabase();
      await mongo.close();
    }
  } finally {
    if (mongoDbOverridden) {
      if (originalMongoDb === undefined) delete process.env.MAPLE_MONGO_DB;
      else process.env.MAPLE_MONGO_DB = originalMongoDb;
    }
  }
});

describe('ensureIndexes — pristine database', () => {
  it('creates the complete downstream index contract and is idempotent', async () => {
    if (!db) return;

    expect((await db.listCollections().toArray()).length).toBe(0);

    const { closeDb, ensureIndexes } = await import('./client.ts');
    await closeDb();
    await ensureIndexes();

    const userEmail = named(await indexesFor(db.collection('users')), 'email_1');
    expect(userEmail.unique).toBe(true);
    expect(userEmail.collation?.locale).toBe('en');
    expect(userEmail.collation?.strength).toBe(2);

    const credentialId = named(await indexesFor(db.collection('credentials')), 'credential_id_1');
    expect(credentialId.unique).toBe(true);

    const inviteExpiry = named(await indexesFor(db.collection('invites')), 'expires_at_1');
    expect(inviteExpiry.expireAfterSeconds).toBe(0);

    named(await indexesFor(db.collection('worker_config')), 'worker_config_name');
    named(await indexesFor(db.collection('assets')), 'stage_preview_version');

    const collectionIndexCounts = new Map<string, number>();
    for (const collectionName of ['users', 'credentials', 'invites', 'worker_config', 'assets']) {
      collectionIndexCounts.set(
        collectionName,
        (await indexesFor(db.collection(collectionName))).length,
      );
    }

    await ensureIndexes();

    for (const [collectionName, count] of collectionIndexCounts) {
      expect((await indexesFor(db.collection(collectionName))).length).toBe(count);
    }
  });
});
