import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MongoClient, ObjectId } from 'mongodb';
import {
  authenticateServiceApiKey,
  createServiceApiKey,
  listServiceApiKeys,
  revokeServiceApiKey,
} from './service-api-keys.ts';

/** Mirrors `KEY_PATTERN` in service-api-keys.ts (module-private there). */
const KEY_SHAPE = /^maple_sk_[a-f0-9]{16}_([A-Za-z0-9_-]{43})$/;

/**
 * The plaintext secret — the third field of `maple_sk_<key id>_<secret>`.
 *
 * Deliberately a shape match, not `split('_')`: the secret is base64url and
 * that alphabet contains `_`, so splitting yields a tail fragment rather than
 * the secret whenever one lands near the end.
 */
function secretOf(key: string): string {
  const match = KEY_SHAPE.exec(key);
  // Report the shape, never the value: this helper exists for a secret-leak
  // assertion, so echoing the key into a CI log on failure would be the very
  // thing it guards against. Length plus prefix is enough to debug a shape
  // change, and neither reveals the secret.
  if (!match) {
    throw new Error(
      `key does not match the expected shape (length ${key.length}, prefix ${key.slice(0, 9)})`,
    );
  }
  return match[1]!;
}

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
    expect(created.key).toMatch(KEY_SHAPE);

    const stored = await mongo!
      .db(TEST_DB)
      .collection('service_api_keys')
      .findOne({ key_id: created.keyId });
    expect(stored?.secret_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.key);
    // Capture the secret by the key's shape rather than `split('_')`. base64url's
    // alphabet includes `_`, so splitting on it returns whatever follows the LAST
    // underscore — a one- or two-character tail whenever the secret happens to
    // contain one near its end. A fragment that short matches something in every
    // stored document (an ObjectId, the 64-char hash, the timestamp), so the old
    // form passed by accident and failed a few percent of the time (#2367).
    expect(JSON.stringify(stored)).not.toContain(secretOf(created.key));

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
