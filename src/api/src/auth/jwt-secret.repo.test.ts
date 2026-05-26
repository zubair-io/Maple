/**
 * DB-backed JWT secret get-or-create. Requires a running MongoDB; skips
 * gracefully if unreachable (mirrors changes.repo.test.ts).
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { MongoClient, type Db } from 'mongodb';
import { getOrCreateJwtSecret, JWT_SECRET_DOC_ID } from './jwt-secret.repo.ts';
import { closeDb } from '../db/client.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_jwt_secret_repo_test_${process.pid}`;
const ORIGINAL_MONGO_DB = process.env.MAPLE_MONGO_DB;
const ORIGINAL_MONGO_URI = process.env.MAPLE_MONGO_URI;

let client: MongoClient | null = null;
let db: Db | null = null;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1_500,
    connectTimeoutMS: 1_500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

beforeEach(async () => {
  client = await tryConnect();
  if (!client) return;
  await closeDb();
  process.env.MAPLE_MONGO_URI = MONGO_URI;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  db = client.db(TEST_DB);
  await db.dropDatabase();
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
  if (ORIGINAL_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = ORIGINAL_MONGO_DB;
  if (ORIGINAL_MONGO_URI === undefined) delete process.env.MAPLE_MONGO_URI;
  else process.env.MAPLE_MONGO_URI = ORIGINAL_MONGO_URI;
  await closeDb();
});

describe('jwt-secret.repo', () => {
  it('creates the secret on first call, returns the same one after', async () => {
    if (!db) return;
    const first = await getOrCreateJwtSecret();
    expect(first.created).toBe(true);
    expect(first.secret.length).toBeGreaterThanOrEqual(32);

    const second = await getOrCreateJwtSecret();
    expect(second.created).toBe(false);
    expect(second.secret).toBe(first.secret);

    // Persisted under the documented _id.
    const doc = await db
      .collection<{ _id: string; value?: string }>('server_state')
      .findOne({ _id: JWT_SECRET_DOC_ID });
    expect(doc?.value).toBe(first.secret);
  });

  it('populates a row that exists but is missing `value`', async () => {
    if (!db) return;
    // A partial prior write could leave the doc with no `value`. The old
    // $setOnInsert path would NOT fill it (the doc already exists), returning
    // an unpersisted candidate — so each process minted a different secret.
    await db.collection('server_state').insertOne({ _id: JWT_SECRET_DOC_ID } as never);

    const r = await getOrCreateJwtSecret();
    expect(r.created).toBe(true);
    expect(r.secret.length).toBeGreaterThanOrEqual(32);

    // It must be persisted, and a follow-up call must read the same value back.
    const again = await getOrCreateJwtSecret();
    expect(again.created).toBe(false);
    expect(again.secret).toBe(r.secret);
  });

  it('concurrent first-calls converge on a single secret', async () => {
    if (!db) return;
    const results = await Promise.all(Array.from({ length: 8 }, () => getOrCreateJwtSecret()));
    const secrets = new Set(results.map((r) => r.secret));
    expect(secrets.size).toBe(1);
    // Exactly one racer should report having minted it.
    expect(results.filter((r) => r.created).length).toBe(1);
  });
});
