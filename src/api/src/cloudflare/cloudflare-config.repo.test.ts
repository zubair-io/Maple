/**
 * DB-backed Cloudflare config repo. Requires a running MongoDB; skips
 * gracefully if unreachable (mirrors jwt-secret.repo.test.ts).
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { MongoClient, type Db } from 'mongodb';
import {
  isCloudflareConfigComplete,
  loadCloudflareConfig,
  resolveCloudflareConfig,
  saveCloudflareConfig,
  toPublicCloudflareConfig,
} from './cloudflare-config.repo.ts';
import { closeDb } from '../db/client.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_cloudflare_config_repo_test_${process.pid}`;
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

describe('cloudflare-config.repo', () => {
  it('returns null when no row exists yet', async () => {
    if (!db) return;
    expect(await loadCloudflareConfig()).toBeNull();
  });

  it('save/load round-trips a full config', async () => {
    if (!db) return;
    await saveCloudflareConfig({
      enabled: true,
      account_id: 'acct123',
      bucket: 'maple-thumbs',
      access_key_id: 'AKIA...',
      secret_access_key: 'shh',
    });
    const loaded = await loadCloudflareConfig();
    expect(loaded?.enabled).toBe(true);
    expect(loaded?.account_id).toBe('acct123');
    expect(loaded?.bucket).toBe('maple-thumbs');
    expect(loaded?.access_key_id).toBe('AKIA...');
    expect(loaded?.secret_access_key).toBe('shh');
  });

  it('partial patches only touch the supplied fields', async () => {
    if (!db) return;
    await saveCloudflareConfig({
      enabled: true,
      account_id: 'acct123',
      bucket: 'maple-thumbs',
      access_key_id: 'AKIA...',
      secret_access_key: 'shh',
    });
    await saveCloudflareConfig({ enabled: false });
    const loaded = await loadCloudflareConfig();
    expect(loaded?.enabled).toBe(false);
    // Untouched fields survive the partial patch.
    expect(loaded?.account_id).toBe('acct123');
    expect(loaded?.secret_access_key).toBe('shh');
  });

  it('omitting secret_access_key from a patch leaves the saved value unchanged', async () => {
    if (!db) return;
    await saveCloudflareConfig({ secret_access_key: 'original-secret' });
    await saveCloudflareConfig({ bucket: 'renamed-bucket' });
    const loaded = await loadCloudflareConfig();
    expect(loaded?.secret_access_key).toBe('original-secret');
    expect(loaded?.bucket).toBe('renamed-bucket');
  });

  it('an explicit null clears secret_access_key', async () => {
    if (!db) return;
    await saveCloudflareConfig({ secret_access_key: 'original-secret' });
    await saveCloudflareConfig({ secret_access_key: null });
    const loaded = await loadCloudflareConfig();
    expect(loaded?.secret_access_key).toBeNull();
  });
});

describe('resolveCloudflareConfig', () => {
  it('falls back to defaults when the DB row is null', () => {
    const resolved = resolveCloudflareConfig(null);
    expect(resolved.enabled).toBe(false);
    expect(resolved.account_id).toBeNull();
    expect(resolved.bucket).toBeNull();
    expect(resolved.access_key_id).toBeNull();
    expect(resolved.secret_access_key).toBeNull();
  });

  it('passes through DB values when present', () => {
    const resolved = resolveCloudflareConfig({
      enabled: true,
      account_id: 'a',
      bucket: 'b',
      access_key_id: 'c',
      secret_access_key: 'd',
    });
    expect(resolved).toMatchObject({
      enabled: true,
      account_id: 'a',
      bucket: 'b',
      access_key_id: 'c',
      secret_access_key: 'd',
    });
  });
});

describe('isCloudflareConfigComplete', () => {
  it('is false when disabled even with full credentials', () => {
    expect(
      isCloudflareConfigComplete({
        enabled: false,
        account_id: 'a',
        bucket: 'b',
        access_key_id: 'c',
        secret_access_key: 'd',
      }),
    ).toBe(false);
  });

  it('is false when enabled but missing any credential field', () => {
    expect(
      isCloudflareConfigComplete({
        enabled: true,
        account_id: 'a',
        bucket: null,
        access_key_id: 'c',
        secret_access_key: 'd',
      }),
    ).toBe(false);
  });

  it('is true when enabled with every credential field set', () => {
    expect(
      isCloudflareConfigComplete({
        enabled: true,
        account_id: 'a',
        bucket: 'b',
        access_key_id: 'c',
        secret_access_key: 'd',
      }),
    ).toBe(true);
  });
});

describe('toPublicCloudflareConfig', () => {
  it('redacts the secret to a boolean and keeps everything else', () => {
    const pub = toPublicCloudflareConfig({
      enabled: true,
      account_id: 'a',
      bucket: 'b',
      access_key_id: 'c',
      secret_access_key: 'shh',
    });
    expect(pub).not.toHaveProperty('secret_access_key');
    expect(pub.secret_access_key_set).toBe(true);
    expect(pub.account_id).toBe('a');
  });

  it('reports secret_access_key_set: false when unset', () => {
    const pub = toPublicCloudflareConfig({
      enabled: false,
      account_id: null,
      bucket: null,
      access_key_id: null,
      secret_access_key: null,
    });
    expect(pub.secret_access_key_set).toBe(false);
  });
});
