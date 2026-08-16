/**
 * scrub-mirror-orphans migration tests. Integration tests against a real Mongo
 * (skip-pass when unreachable) because the migration persists discovery state via
 * the migration-config repo. The filesystem diff itself (findMirrorOrphans /
 * deleteOrphanRefs) is covered separately in `../mirror/scrub.test.ts`.
 *
 * Covers the two-phase shape: a sentinel count before discovery, a discovery
 * batch that finds orphans without deleting, a deletion batch that removes them,
 * and the primary-offline safety guard (never deletes, count resolves to 0).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, type Db } from 'mongodb';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTestDb } from '../../db/test-db.test-helpers.ts';

const TEST_DB = withTestDb(`maple_test_scruborphans_${process.pid}`);
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let reachable = false;
let db: Db | null = null;
let primary: string;
let mirror: string;

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
    console.log('[scrub-mirror-orphans.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  process.env.MAPLE_MONGO_DB = TEST_DB;
  const { closeDb } = await import('../../db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!reachable || !db) return;
  await db.collection('app_settings').deleteMany({});
  primary = mkdtempSync(join(tmpdir(), 'scrubmig-primary-'));
  mirror = mkdtempSync(join(tmpdir(), 'scrubmig-mirror-'));
  const { clearMirrorRoots, setMirrorRoots } = await import('../../fs/mirror-registry.ts');
  clearMirrorRoots();
  setMirrorRoots({ [primary]: [mirror] });
});

afterAll(async () => {
  if (mongo) await mongo.close();
  if (primary) rmSync(primary, { recursive: true, force: true });
  if (mirror) rmSync(mirror, { recursive: true, force: true });
});

describe('scrub-mirror-orphans migration', () => {
  it('discovers, then deletes orphans across two batches', async () => {
    if (!reachable) return;
    // Mirror holds a stranded old-layout copy (no primary) + a matched file.
    mkdirSync(join(mirror, '2024', '12-25'), { recursive: true });
    writeFileSync(join(mirror, '2024', '12-25', 'IMG.dng'), 'x'); // orphan
    mkdirSync(join(primary, '2024', 'California'), { recursive: true });
    writeFileSync(join(primary, '2024', 'California', 'IMG.dng'), 'x');
    mkdirSync(join(mirror, '2024', 'California'), { recursive: true });
    writeFileSync(join(mirror, '2024', 'California', 'IMG.dng'), 'x'); // matched

    const { setMigrationEnabled } = await import('../migration-config.repo.ts');
    const { scrubMirrorOrphans } = await import('./scrub-mirror-orphans.ts');
    await setMigrationEnabled(scrubMirrorOrphans.id, true, new Date().toISOString());

    // Before discovery: sentinel keeps the worker active.
    expect(await scrubMirrorOrphans.countRemaining()).toBe(1);

    // Discovery batch: finds the orphan, deletes nothing.
    const first = await scrubMirrorOrphans.runBatch(50);
    expect(first).toEqual({ processed: 0, errors: 0 });
    expect(await scrubMirrorOrphans.countRemaining()).toBe(1);
    expect(existsSync(join(mirror, '2024', '12-25', 'IMG.dng'))).toBe(true);

    // Deletion batch: removes the orphan, keeps the matched file, prunes the dir.
    const second = await scrubMirrorOrphans.runBatch(50);
    expect(second.processed).toBe(1);
    expect(second.errors).toBe(0);
    expect(existsSync(join(mirror, '2024', '12-25', 'IMG.dng'))).toBe(false);
    expect(existsSync(join(mirror, '2024', '12-25'))).toBe(false); // pruned
    expect(existsSync(join(mirror, '2024', 'California', 'IMG.dng'))).toBe(true); // kept
    expect(await scrubMirrorOrphans.countRemaining()).toBe(0);
  });

  it('never deletes when the primary root is offline', async () => {
    if (!reachable) return;
    const offlinePrimary = join(tmpdir(), `scrubmig-gone-${process.pid}-${Date.now()}`);
    writeFileSync(join(mirror, 'IMG.dng'), 'x');
    const { setMirrorRoots } = await import('../../fs/mirror-registry.ts');
    setMirrorRoots({ [offlinePrimary]: [mirror] });

    const { setMigrationEnabled } = await import('../migration-config.repo.ts');
    const { scrubMirrorOrphans } = await import('./scrub-mirror-orphans.ts');
    await setMigrationEnabled(scrubMirrorOrphans.id, true, new Date().toISOString());

    // Discovery skips the offline primary entirely → nothing to delete.
    await scrubMirrorOrphans.runBatch(50);
    expect(await scrubMirrorOrphans.countRemaining()).toBe(0);
    expect(existsSync(join(mirror, 'IMG.dng'))).toBe(true); // untouched

    // A deletion batch is still a no-op and never touches the file.
    const res = await scrubMirrorOrphans.runBatch(50);
    expect(res.processed).toBe(0);
    expect(existsSync(join(mirror, 'IMG.dng'))).toBe(true);
  });

  it('reports 0 remaining while disabled', async () => {
    if (!reachable) return;
    const { scrubMirrorOrphans } = await import('./scrub-mirror-orphans.ts');
    // No enablement written → disabled → cheap 0 (no walk, no sentinel).
    expect(await scrubMirrorOrphans.countRemaining()).toBe(0);
  });
});
