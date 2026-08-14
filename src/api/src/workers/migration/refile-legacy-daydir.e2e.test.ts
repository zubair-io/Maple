/**
 * End-to-end tests for the refile-legacy-daydir cleanup migration
 * (Mongo-gated). Seeds legacy day-dir assets + real temp files and drives one
 * migration tick through the SAME worker path `refile-backups` runs through
 * (`runMigrationTickOnce`), asserting the on-disk move, the repoint, the
 * version stamp, and the unresolved-stamp-and-leave-in-place path. The pure
 * candidate/dir logic is unit-tested in `refile-legacy-daydir.test.ts`.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import { stageRegistry } from '../registry.ts';
import { runMigrationTickOnce } from '../migration.ts';
import { LEGACY_DAYDIR_VERSION } from './refile-legacy-daydir.ts';
import type { getDb as GetDbFn } from '../../db/client.ts';

const MIGRATION_ID = 'refile-legacy-daydir';

async function connectOrSkip(label: string): Promise<Awaited<ReturnType<typeof GetDbFn>> | null> {
  try {
    const { getDb } = await import('../../db/client.ts');
    return await getDb();
  } catch {
    console.log(`MongoDB unreachable — skipping ${label}`);
    return null;
  }
}

// See refile-backups.e2e.test.ts for why this connection MUST be closed on
// both ends (#2787): `getDb()` only re-reads `MAPLE_MONGO_DB` when no
// connection is cached, so a leaked one here pins every later file in the
// same `bun test` process to this file's ambient database.
beforeAll(async () => {
  await (await import('../../db/client.ts')).closeDb();
});

afterAll(async () => {
  await (await import('../../db/client.ts')).closeDb();
});

describe('refile-legacy-daydir end-to-end', () => {
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

  it('moves a legacy day-dir asset using the filename-date fallback (no EXIF), stamps it, idempotent', async () => {
    const db = await connectOrSkip('filename-fallback move e2e');
    if (!db) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { resetMigrationState } = await import('../migration-config.repo.ts');
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refile-legacy-daydir-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    const oldRel = '2021/61st Street/01-05';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_20170930_121056_345.jpg'), 'pixels');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'legacy-daydir-filename-fallback',
      fileinfo: [
        {
          path: oldRel,
          filename: 'IMG_20170930_121056_345.jpg',
          library_id: libId,
          deleted_at: null,
        },
      ],
      place: null,
      is_screenshot: false,
      exif: { captured_at: null, captured_year: null, captured_month: null },
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      stages: {},
    } as never);

    try {
      await runTick();
      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string; filename: string }[];
        legacy_daydir_version?: number;
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe('2017/Misc');
      expect(doc?.fileinfo?.[0].filename).toBe('IMG_20170930_121056_345.jpg');
      expect(doc?.legacy_daydir_version).toBe(LEGACY_DAYDIR_VERSION);

      expect(
        await fs.readFile(path.join(dir, '2017', 'Misc', 'IMG_20170930_121056_345.jpg'), 'utf8'),
      ).toBe('pixels');
      await expect(fs.stat(path.join(dir, oldRel))).rejects.toThrow();

      // A second tick finds nothing left to do — the stamp excludes it.
      expect(
        await assets.countDocuments({
          _id,
          legacy_daydir_version: { $ne: LEGACY_DAYDIR_VERSION },
        }),
      ).toBe(0);
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });

  it('stamps an unresolved asset (no EXIF, no parseable filename date) and leaves it in place', async () => {
    const db = await connectOrSkip('unresolved e2e');
    if (!db) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { resetMigrationState } = await import('../migration-config.repo.ts');
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refile-legacy-daydir-unresolved-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    const oldRel = '2021/Some Place/03-11';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'DSC_0001.jpg'), 'pixels');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'legacy-daydir-unresolved',
      fileinfo: [{ path: oldRel, filename: 'DSC_0001.jpg', library_id: libId, deleted_at: null }],
      place: null,
      is_screenshot: false,
      exif: { captured_at: null, captured_year: null, captured_month: null },
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      stages: {},
    } as never);

    try {
      await runTick();
      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string }[];
        legacy_daydir_version?: number;
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe(oldRel);
      expect(doc?.legacy_daydir_version).toBe(LEGACY_DAYDIR_VERSION);

      const stillThere = await fs.readFile(path.join(dir, oldRel, 'DSC_0001.jpg'), 'utf8');
      expect(stillThere).toBe('pixels');
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });

  it('moves a no-location legacy day-dir asset (<year>/<MM>/<DD>) into <year>/Misc', async () => {
    const db = await connectOrSkip('no-location shape e2e');
    if (!db) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { resetMigrationState } = await import('../migration-config.repo.ts');
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refile-legacy-daydir-nolocation-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    const oldRel = '2021/01/05';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_20170930_121056_345.jpg'), 'pixels');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'legacy-daydir-no-location',
      fileinfo: [
        {
          path: oldRel,
          filename: 'IMG_20170930_121056_345.jpg',
          library_id: libId,
          deleted_at: null,
        },
      ],
      place: null,
      is_screenshot: false,
      exif: { captured_at: null, captured_year: null, captured_month: null },
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      stages: {},
    } as never);

    try {
      await runTick();
      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string; filename: string }[];
        legacy_daydir_version?: number;
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe('2017/Misc');
      expect(doc?.legacy_daydir_version).toBe(LEGACY_DAYDIR_VERSION);

      expect(
        await fs.readFile(path.join(dir, '2017', 'Misc', 'IMG_20170930_121056_345.jpg'), 'utf8'),
      ).toBe('pixels');
      await expect(fs.stat(path.join(dir, oldRel))).rejects.toThrow();
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });

  it('resolves via EXIF when present, overriding a disagreeing filename date', async () => {
    const db = await connectOrSkip('exif priority e2e');
    if (!db) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { resetMigrationState } = await import('../migration-config.repo.ts');
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refile-legacy-daydir-exif-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    const oldRel = '2021/61st Street/01-05';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_20170930_121056_345.jpg'), 'pixels');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'legacy-daydir-exif-priority',
      fileinfo: [
        {
          path: oldRel,
          filename: 'IMG_20170930_121056_345.jpg',
          library_id: libId,
          deleted_at: null,
        },
      ],
      place: null,
      is_screenshot: false,
      exif: { captured_at: '2021-01-05T00:00:00.000Z', captured_year: 2021, captured_month: 1 },
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      stages: {},
    } as never);

    try {
      await runTick();
      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string }[];
        legacy_daydir_version?: number;
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe('2021/Misc');
      expect(doc?.legacy_daydir_version).toBe(LEGACY_DAYDIR_VERSION);
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });

  it('does not stamp a SourceMissingError when the library root itself is unavailable (offline mount)', async () => {
    const db = await connectOrSkip('offline mount e2e');
    if (!db) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { resetMigrationState } = await import('../migration-config.repo.ts');
    const assets = db.collection('assets');
    const libId = new ObjectId();

    // A library root that doesn't exist on disk at all — simulates an
    // unmounted network/bind mount, where every child path ENOENTs
    // indistinguishably from a genuinely deleted file.
    const offlineRoot = path.join(
      os.tmpdir(),
      `refile-legacy-daydir-offline-${libId.toHexString()}`,
    );
    setLibraryRootsForTests(new Map([[libId.toHexString(), offlineRoot]]));

    const oldRel = '2021/61st Street/01-05';
    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'legacy-daydir-offline-root',
      fileinfo: [
        {
          path: oldRel,
          filename: 'IMG_20170930_121056_345.jpg',
          library_id: libId,
          deleted_at: null,
        },
      ],
      place: null,
      is_screenshot: false,
      exif: { captured_at: null, captured_year: null, captured_month: null },
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      stages: {},
    } as never);

    try {
      await runTick();
      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string }[];
        legacy_daydir_version?: number;
      } | null;
      // Left exactly where it was and NOT stamped — a later tick, once the
      // mount returns, re-verifies instead of permanently giving up on a
      // false "file deleted" read.
      expect(doc?.fileinfo?.[0].path).toBe(oldRel);
      expect(doc?.legacy_daydir_version).toBeUndefined();
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });

  it('moves the validated live day-dir entry, not a stale missing_since-tagged earlier entry', async () => {
    const db = await connectOrSkip('multi-entry primary-mismatch e2e');
    if (!db) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { resetMigrationState } = await import('../migration-config.repo.ts');
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refile-legacy-daydir-multientry-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    // Only the SECOND (live, day-dir) entry has a real file on disk — the
    // first entry is tagged missing_since (not deleted_at), so
    // assetActiveFileInfo's "first non-deleted" pick (which ignores
    // missing_since) would wrongly select it if the whole doc were handed to
    // moveBackupAsset unnarrowed.
    const liveRel = '2021/61st Street/01-05';
    await fs.mkdir(path.join(dir, ...liveRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, liveRel, 'IMG_20170930_121056_345.jpg'), 'pixels');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'legacy-daydir-multientry',
      fileinfo: [
        {
          path: '2021/StaleEntry',
          filename: 'GHOST.HEIC',
          library_id: libId,
          deleted_at: null,
          missing_since: '2020-01-01T00:00:00.000Z',
        },
        {
          path: liveRel,
          filename: 'IMG_20170930_121056_345.jpg',
          library_id: libId,
          deleted_at: null,
          missing_since: null,
        },
      ],
      place: null,
      is_screenshot: false,
      exif: { captured_at: null, captured_year: null, captured_month: null },
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      stages: {},
    } as never);

    try {
      await runTick();
      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string; filename: string; missing_since?: string | null }[];
        legacy_daydir_version?: number;
      } | null;
      const live = doc?.fileinfo?.find((fi) => fi.filename === 'IMG_20170930_121056_345.jpg');
      expect(live?.path).toBe('2017/Misc');
      expect(doc?.legacy_daydir_version).toBe(LEGACY_DAYDIR_VERSION);

      expect(
        await fs.readFile(path.join(dir, '2017', 'Misc', 'IMG_20170930_121056_345.jpg'), 'utf8'),
      ).toBe('pixels');
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });
});
