import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MongoClient, ObjectId } from 'mongodb';
import {
  authenticateServiceApiKey,
  createServiceApiKey,
  listServiceApiKeys,
  revokeServiceApiKey,
} from './service-api-keys.ts';

const TEST_DB = `maple_test_service_api_keys_${process.pid}`;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const PRIOR_DB = process.env.MAPLE_MONGO_DB;
process.env.MAPLE_MONGO_DB = TEST_DB;

let mongo: MongoClient | null = null;
let mongoReachable = false;

beforeAll(async () => {
  mongo = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await mongo.connect();
    await mongo.db('admin').command({ ping: 1 });
    mongoReachable = true;
    await mongo.db(TEST_DB).dropDatabase();
    const { closeDb } = await import('../db/client.ts');
    await closeDb();
  } catch {
    mongoReachable = false;
    await mongo.close().catch(() => {});
    mongo = null;
    console.log('[service-api-keys.test] skipping: MongoDB unreachable');
  }
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await mongo!.db(TEST_DB).collection('service_api_keys').deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo
      .db(TEST_DB)
      .dropDatabase()
      .catch(() => {});
    await mongo.close().catch(() => {});
  }
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
  if (PRIOR_DB === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = PRIOR_DB;
});

describe('service API keys', () => {
  it('stores only a secret hash and returns plaintext once', async () => {
    if (!mongoReachable) return;
    const created = await createServiceApiKey({
      name: 'SugarMaple',
      createdBy: new ObjectId(),
    });
    expect(created.key).toMatch(/^maple_sk_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/);

    const stored = await mongo!
      .db(TEST_DB)
      .collection('service_api_keys')
      .findOne({ key_id: created.keyId });
    expect(stored?.secret_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.key);
    expect(JSON.stringify(stored)).not.toContain(created.key.split('_').at(-1)!);

    const listed = await listServiceApiKeys();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      keyId: created.keyId,
      name: 'SugarMaple',
      scopes: ['assets:search'],
    });
    expect(JSON.stringify(listed)).not.toContain('secret_hash');
  });

  it('authenticates scope, then rejects revoked and expired keys', async () => {
    if (!mongoReachable) return;
    const created = await createServiceApiKey({
      name: 'Search consumer',
      createdBy: new ObjectId(),
    });
    const valid = await authenticateServiceApiKey(`Bearer ${created.key}`, 'assets:search');
    expect(valid.ok).toBe(true);

    expect(await revokeServiceApiKey(created.keyId)).toBe(true);
    const revoked = await authenticateServiceApiKey(`Bearer ${created.key}`, 'assets:search');
    expect(revoked).toMatchObject({ ok: false, status: 401, reason: 'revoked_key' });

    const expired = await createServiceApiKey({
      name: 'Expired',
      createdBy: new ObjectId(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await mongo!
      .db(TEST_DB)
      .collection('service_api_keys')
      .updateOne({ key_id: expired.keyId }, { $set: { expires_at: new Date(0) } });
    const expiredResult = await authenticateServiceApiKey(`Bearer ${expired.key}`, 'assets:search');
    expect(expiredResult).toMatchObject({ ok: false, status: 401, reason: 'expired_key' });
  });
});
