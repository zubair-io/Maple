/**
 * End-to-end tests for the refile-backups cleanup migration (Mongo-gated).
 *
 * Seeds backup-origin assets + real temp files and drives one migration tick,
 * then asserts the on-disk move, the repoint, the v3 stamp, auto-disable, and the
 * missing-source guard. Plus the describe-stage `relocateBackupScreenshot` hook.
 * Skips when MongoDB is unreachable (mirrors the deleted migration tests /
 * smoke.test). The pure `computeCanonicalDir` logic is unit-tested in
 * `refile-backups.test.ts`.
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
import type { getDb as GetDbFn } from '../../db/client.ts';

const MIGRATION_ID = 'refile-backups';

function place(p: {
  address?: Partial<Place['address']>;
  rollups?: Partial<Place['rollups']>;
  pois?: Place['pois'];
}): Place {
  return {
    source: 'nominatim',
    geocoder_version: 1,
    geocoded_at: '2024-01-01T00:00:00.000Z',
    lat: 0,
    lon: 0,
    display_name: null,
    address: (p.address ?? {}) as Place['address'],
    pois: p.pois ?? [],
    rollups: {
      locality: null,
      region: null,
      country_code: null,
      ...(p.rollups ?? {}),
    },
    search_blob: '',
  };
}

// ── Mongo-gated end-to-end ──────────────────────────────────────────────────

async function connectOrSkip(label: string): Promise<Awaited<ReturnType<typeof GetDbFn>> | null> {
  try {
    const { getDb } = await import('../../db/client.ts');
    return await getDb();
  } catch {
    console.log(`MongoDB unreachable — skipping ${label}`);
    return null;
  }
}

describe('refile-backups end-to-end', () => {
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

  it('moves a geocoded backup into year/Country/City, stamps v3, resets cache, idempotent', async () => {
    const db = await connectOrSkip('geo move e2e');
    if (!db) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { resetMigrationState } = await import('../migration-config.repo.ts');
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refile-geo-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    const oldRel = '2024/Tokyo';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_GEO.HEIC'), 'pixels');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_GEO.xmp'), 'edits');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'refile-geo-id',
      fileinfo: [
        {
          path: oldRel,
          filename: 'IMG_GEO.HEIC',
          library_id: libId,
          deleted_at: null,
        },
      ],
      phasset_links: [{ device_id: 'dev', phasset_local_id: 'ph', first_seen: new Date() }],
      place: place({
        address: { country: 'Japan', country_code: 'jp' },
        rollups: { locality: 'Kyoto', country_code: 'jp' },
      }),
      exif: { captured_year: 2024 },
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      stages: { thumb: { version: 1 }, preview: { version: 1 } },
    } as never);

    try {
      await runTick();
      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string; filename: string }[];
        stages?: Record<string, { version: number }>;
        backup_layout_version?: number;
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe('2024/Japan/Kyoto');
      expect(doc?.fileinfo?.[0].filename).toBe('IMG_GEO.HEIC');
      expect(doc?.backup_layout_version).toBe(BACKUP_LAYOUT_VERSION);
      expect(doc?.stages?.thumb.version).toBe(0);
      expect(doc?.stages?.preview.version).toBe(0);

      expect(await fs.readFile(path.join(dir, '2024/Japan/Kyoto/IMG_GEO.HEIC'), 'utf8')).toBe(
        'pixels',
      );
      expect(await fs.readFile(path.join(dir, '2024/Japan/Kyoto/IMG_GEO.xmp'), 'utf8')).toBe(
        'edits',
      );
      await expect(fs.stat(path.join(dir, oldRel))).rejects.toThrow();

      expect(
        await assets.countDocuments({
          _id,
          backup_layout_version: { $ne: BACKUP_LAYOUT_VERSION },
        }),
      ).toBe(0);
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });

  it('THE regression: unfreezes a backup_layout_version:2 asset stuck at a stale POI path', async () => {
    const db = await connectOrSkip('regression e2e');
    if (!db) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { resetMigrationState } = await import('../migration-config.repo.ts');
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refile-regression-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    // The exact frozen state: stamped v2, sitting at a pre-geo POI path, but the
    // place now fully resolves to France/Paris. The old `{ $ne: 2 }` selector
    // skipped it forever; the v3 bump must re-sweep and move it.
    const oldRel = '2026/24 rue Vignon';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_0333.JPG'), 'pixels');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'refile-regression-id',
      fileinfo: [
        {
          path: oldRel,
          filename: 'IMG_0333.JPG',
          library_id: libId,
          deleted_at: null,
        },
      ],
      phasset_links: [
        {
          device_id: 'dev',
          phasset_local_id: 'ph',
          phasset_cloud_id: 'cloud-xyz',
          first_seen: new Date(),
        },
      ],
      backup_layout_version: 2, // ← the frozen stamp
      place: place({
        address: {
          country: 'France',
          country_code: 'fr',
          state: 'Île-de-France',
        },
        rollups: { locality: 'Paris', country_code: 'fr' },
        pois: [{ name: '24 rue Vignon', category: 'building', type: 'apartments' }],
      }),
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
        fileinfo?: { path: string }[];
        backup_layout_version?: number;
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe('2026/France/Paris');
      expect(doc?.backup_layout_version).toBe(BACKUP_LAYOUT_VERSION);
      expect(await fs.readFile(path.join(dir, '2026/France/Paris/IMG_0333.JPG'), 'utf8')).toBe(
        'pixels',
      );
      await expect(fs.stat(path.join(dir, oldRel))).rejects.toThrow();
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });

  it('moves a flagged screenshot into year/Screenshot', async () => {
    const db = await connectOrSkip('screenshot move e2e');
    if (!db) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { resetMigrationState } = await import('../migration-config.repo.ts');
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refile-shot-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    const oldRel = '2024/03';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'Screenshot 2024-03-15.png'), 'pixels');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'refile-shot-id',
      fileinfo: [
        {
          path: oldRel,
          filename: 'Screenshot 2024-03-15.png',
          library_id: libId,
          deleted_at: null,
        },
      ],
      phasset_links: [{ device_id: 'dev', phasset_local_id: 'ph', first_seen: new Date() }],
      is_screenshot: true,
      exif: { captured_year: 2024 },
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      stages: { thumb: { version: 1 }, preview: { version: 1 } },
    } as never);

    try {
      await runTick();
      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string }[];
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe('2024/Screenshot');
      expect(
        await fs.readFile(path.join(dir, '2024/Screenshot/Screenshot 2024-03-15.png'), 'utf8'),
      ).toBe('pixels');
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });

  it('flattens an old MM-DD day-folder for a non-geo backup', async () => {
    const db = await connectOrSkip('flatten e2e');
    if (!db) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { resetMigrationState } = await import('../migration-config.repo.ts');
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refile-flatten-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    const oldRel = '2024/Tokyo/03-15';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_E2E.HEIC'), 'pixels');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'refile-flatten-id',
      fileinfo: [
        {
          path: oldRel,
          filename: 'IMG_E2E.HEIC',
          library_id: libId,
          deleted_at: null,
        },
      ],
      phasset_links: [{ device_id: 'dev', phasset_local_id: 'ph', first_seen: new Date() }],
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      stages: { thumb: { version: 1 }, preview: { version: 1 } },
    } as never);

    try {
      await runTick();
      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string }[];
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe('2024/Misc');
      expect(await fs.readFile(path.join(dir, '2024/Misc/IMG_E2E.HEIC'), 'utf8')).toBe('pixels');
      await expect(fs.stat(path.join(dir, oldRel))).rejects.toThrow();
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });

  it('already-correct asset is stamped without moving the file (no-op)', async () => {
    const db = await connectOrSkip('noop e2e');
    if (!db) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { resetMigrationState } = await import('../migration-config.repo.ts');
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refile-noop-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    const rel = '2024/France/Paris';
    await fs.mkdir(path.join(dir, ...rel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, rel, 'IMG_OK.HEIC'), 'pixels');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'refile-noop-id',
      fileinfo: [
        {
          path: rel,
          filename: 'IMG_OK.HEIC',
          library_id: libId,
          deleted_at: null,
        },
      ],
      phasset_links: [{ device_id: 'dev', phasset_local_id: 'ph', first_seen: new Date() }],
      place: place({
        address: { country: 'France', country_code: 'fr' },
        rollups: { locality: 'Paris', country_code: 'fr' },
      }),
      exif: { captured_year: 2024 },
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      stages: { thumb: { version: 4 }, preview: { version: 4 } },
    } as never);

    try {
      await runTick();
      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string }[];
        stages?: Record<string, { version: number }>;
        backup_layout_version?: number;
      } | null;
      expect(doc?.backup_layout_version).toBe(BACKUP_LAYOUT_VERSION);
      expect(doc?.fileinfo?.[0].path).toBe(rel);
      expect(doc?.stages?.thumb.version).toBe(4); // not reset — no move happened
      expect(await fs.readFile(path.join(dir, rel, 'IMG_OK.HEIC'), 'utf8')).toBe('pixels');
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });

  it('auto-disables its own toggle when the sweep completes', async () => {
    const db = await connectOrSkip('auto-disable e2e');
    if (!db) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { resetMigrationState, loadMigrationState } = await import('../migration-config.repo.ts');
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refile-autodisable-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    const oldRel = '2024/Tokyo';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_AD.HEIC'), 'pixels');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'refile-ad-id',
      fileinfo: [
        {
          path: oldRel,
          filename: 'IMG_AD.HEIC',
          library_id: libId,
          deleted_at: null,
        },
      ],
      phasset_links: [{ device_id: 'dev', phasset_local_id: 'ph', first_seen: new Date() }],
      place: place({
        address: { country: 'Japan', country_code: 'jp' },
        rollups: { locality: 'Kyoto', country_code: 'jp' },
      }),
      exif: { captured_year: 2024 },
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      stages: { thumb: { version: 1 }, preview: { version: 1 } },
    } as never);

    try {
      await runTick();
      // One tick clears the only candidate, so the worker marks it done AND flips
      // the operator toggle off — no "remember to disable it" caveat.
      const state = await loadMigrationState(MIGRATION_ID);
      expect(state.status).toBe('done');
      expect(state.enabled).toBe(false);
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });

  it('stamps an asset whose source file is missing (no head-of-line stall)', async () => {
    const db = await connectOrSkip('source-missing e2e');
    if (!db) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { resetMigrationState } = await import('../migration-config.repo.ts');
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refile-missing-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    // Deliberately do NOT create the file on disk → moveBackupAsset throws
    // SourceMissingError. The asset must still be stamped so it drops out of the
    // candidate set, or a whole batch of missing sources would head-of-line-block
    // the rest of the library every tick.
    const oldRel = '2024/Tokyo';
    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'refile-missing-id',
      fileinfo: [
        {
          path: oldRel,
          filename: 'GHOST.HEIC',
          library_id: libId,
          deleted_at: null,
        },
      ],
      phasset_links: [{ device_id: 'dev', phasset_local_id: 'ph', first_seen: new Date() }],
      place: place({
        address: { country: 'Japan', country_code: 'jp' },
        rollups: { locality: 'Kyoto', country_code: 'jp' },
      }),
      exif: { captured_year: 2024 },
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
    } as never);

    try {
      await runTick();
      const doc = (await assets.findOne({ _id })) as {
        backup_layout_version?: number;
        fileinfo?: { path: string }[];
      } | null;
      expect(doc?.backup_layout_version).toBe(BACKUP_LAYOUT_VERSION); // stamped → drops out
      expect(doc?.fileinfo?.[0].path).toBe(oldRel); // file untouched (still missing)
      expect(
        await assets.countDocuments({
          _id,
          backup_layout_version: { $ne: BACKUP_LAYOUT_VERSION },
        }),
      ).toBe(0);
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });
});
