/**
 * Regression (#1519): the refile-backups migration must operate on the asset's
 * canonical *live* fileinfo entry, not `fileinfo[0]`.
 *
 * Production froze at 34,166 remaining because delete-then-readd backup docs have
 * a soft-deleted tombstone at `fileinfo[0]` and the live file at `fileinfo[1]`.
 * The old selector (`'fileinfo.0.deleted_at': null`) leaked them through, the
 * migration took `fileinfo[0]` (the tombstone), `moveBackupAsset` returned
 * `'skipped'` without stamping, and — because the fetch has no sort — those
 * un-stampable docs head-of-line-blocked every batch (`processed:0` forever).
 *
 * Mongo-gated; skips when MongoDB is unreachable (mirrors refile-backups.e2e).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import { stageRegistry } from '../registry.ts';
import { runMigrationTickOnce } from '../migration.ts';
import { BACKUP_LAYOUT_VERSION } from './refile-backups.ts';
import type { Place } from '../../db/schema.ts';
import type { getDb } from '../../db/client.ts';

const MIGRATION_ID = 'refile-backups';

function parisPlace(): Place {
  return {
    source: 'nominatim',
    geocoder_version: 1,
    geocoded_at: '2024-01-01T00:00:00.000Z',
    lat: 0,
    lon: 0,
    display_name: null,
    address: { country: 'France', country_code: 'fr', state: 'Île-de-France' } as Place['address'],
    pois: [{ name: 'Adam', category: 'tourism', type: 'artwork' }],
    rollups: { locality: 'Paris', region: 'Île-de-France', country_code: 'fr' },
    search_blob: '',
  };
}

async function connectOrSkip(
  label: string,
): Promise<Awaited<ReturnType<typeof getDb>> | null> {
  try {
    const { getDb } = await import('../../db/client.ts');
    return await getDb();
  } catch {
    console.log(`MongoDB unreachable — skipping ${label}`);
    return null;
  }
}

describe('refile-backups — soft-deleted primary (#1519)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
    stageRegistry._resetForTests();
  });

  async function runTick(): Promise<void> {
    const { setMigrationEnabled, resetMigrationState } =
      await import('../migration-config.repo.ts');
    await resetMigrationState(MIGRATION_ID);
    await setMigrationEnabled(MIGRATION_ID, true, new Date().toISOString());
    await runMigrationTickOnce(50, new Date().toISOString());
  }

  it('refiles the LIVE entry of a [tombstone, live] doc and stamps it (no clog)', async () => {
    const db = await connectOrSkip('tombstone-primary regression');
    if (!db) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { resetMigrationState } = await import('../migration-config.repo.ts');
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refile-tombstone-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    // The live file sits at the stale path; fileinfo[0] is a tombstone for the
    // same path (delete-then-readd), fileinfo[1] is the live entry.
    const oldRel = '2026/Adam';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IDG_0001.JPG'), 'pixels');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'refile-tombstone-id',
      fileinfo: [
        {
          path: oldRel,
          filename: 'IDG_0001.JPG',
          library_id: libId,
          deleted_at: '2026-05-22T00:00:00.000Z', // tombstone
        },
        { path: oldRel, filename: 'IDG_0001.JPG', library_id: libId, deleted_at: null }, // live
      ],
      phasset_links: [{ device_id: 'dev', phasset_local_id: 'ph', first_seen: new Date() }],
      place: parisPlace(),
      exif: { captured_year: 2026 },
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      stages: { thumb: { version: 2 }, preview: { version: 2 } },
    } as never);

    try {
      await runTick();
      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string; deleted_at: string | null }[];
        backup_layout_version?: number;
      } | null;

      // The live entry was repointed to the canonical dir; the tombstone is untouched.
      const live = doc?.fileinfo?.find((f) => f.deleted_at == null);
      const tombstone = doc?.fileinfo?.find((f) => f.deleted_at != null);
      expect(live?.path).toBe('2026/France/Paris');
      expect(tombstone?.path).toBe(oldRel);

      // Stamped done → drops out of the candidate set (no more clog).
      expect(doc?.backup_layout_version).toBe(BACKUP_LAYOUT_VERSION);
      expect(
        await assets.countDocuments({ _id, backup_layout_version: { $ne: BACKUP_LAYOUT_VERSION } }),
      ).toBe(0);

      // The file actually moved on disk.
      expect(await fs.readFile(path.join(dir, '2026/France/Paris/IDG_0001.JPG'), 'utf8')).toBe(
        'pixels',
      );
      await expect(fs.stat(path.join(dir, oldRel))).rejects.toThrow();
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });
});
