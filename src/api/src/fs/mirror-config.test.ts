/**
 * loadMirrorConfig tests — verifies the Mongo-backed `FolderDoc.mirrors` config
 * is hydrated into the in-memory registry the mirror-aware fs shim consults.
 *
 * This is the call the worker tier was missing: without it `isMirroringActive()`
 * is false in the worker process, so every mirror-aware write there (backup-
 * folder migrations, imports, trash deletes) silently resolves to zero targets
 * and the mirror drifts — and the scan/copy reconcile that should catch the
 * drift is itself gated off. A regression here would re-break worker-side
 * mirroring, so it is worth a direct test.
 *
 * Integration test against a real Mongo (skip-pass when unreachable).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { MongoClient, type Db } from 'mongodb';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTestDb } from '../db/test-db.test-helpers.ts';

const TEST_DB = withTestDb(`maple_test_mirrorcfg_${process.pid}`);
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let reachable = false;
let db: Db | null = null;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
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
  reachable = mongo !== null;
  if (!reachable) {
    console.log('[mirror-config.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  // Pin the app's getDb() singleton to OUR test DB, then force a reconnect so
  // loadMirrorConfig() reads the fixtures we write here.
  process.env.MAPLE_MONGO_DB = TEST_DB;
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!reachable || !db) return;
  await db.collection('folders').deleteMany({});
  const { clearMirrorRoots } = await import('./mirror-registry.ts');
  clearMirrorRoots();
});

afterAll(async () => {
  if (mongo) await mongo.close();
});

describe('loadMirrorConfig', () => {
  it('hydrates enabled mirror roots into the registry', async () => {
    if (!reachable) return;
    const primary = mkdtempSync(join(tmpdir(), 'cfg-primary-'));
    const mirror = mkdtempSync(join(tmpdir(), 'cfg-mirror-'));
    await db!.collection('folders').insertOne({
      path: primary,
      label: 'lib',
      mirrors: [{ path: mirror, enabled: true }],
    } as Record<string, unknown>);

    const { isMirroringActive, snapshotMirrorRoots } = await import('./mirror-registry.ts');
    expect(isMirroringActive()).toBe(false); // nothing loaded yet

    const { loadMirrorConfig } = await import('./mirror-config.ts');
    await loadMirrorConfig();

    expect(isMirroringActive()).toBe(true);
    expect(snapshotMirrorRoots()[primary]).toEqual([mirror]);
  });

  it('excludes disabled mirrors', async () => {
    if (!reachable) return;
    const primary = mkdtempSync(join(tmpdir(), 'cfg-primary2-'));
    const mirror = mkdtempSync(join(tmpdir(), 'cfg-mirror2-'));
    await db!.collection('folders').insertOne({
      path: primary,
      label: 'lib',
      mirrors: [{ path: mirror, enabled: false }],
    } as Record<string, unknown>);

    const { loadMirrorConfig } = await import('./mirror-config.ts');
    await loadMirrorConfig();

    const { isMirroringActive } = await import('./mirror-registry.ts');
    expect(isMirroringActive()).toBe(false);
  });
});
