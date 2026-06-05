/**
 * Tests for the geo-layout migration.
 *
 *  - computeGeoDir: pure path/segment derivation (no DB).
 *  - End-to-end runBatch: seeds a backup-origin asset with a `place` + a real
 *    temp file and drives one tick. Skips when MongoDB is unreachable (mirrors
 *    migration.test.ts / smoke.test).
 */
import { describe, it, test, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import { stageRegistry } from '../registry.ts';
import { runMigrationTickOnce } from '../migration.ts';
import { computeGeoDir, BACKUP_GEO_LAYOUT_VERSION } from './restructure-backup-geo.ts';
import type { FileInfo, Place } from '../../db/schema.ts';

const MIGRATION_ID = 'restructure-backup-geo';

function fi(p: string): FileInfo {
  return { path: p, filename: 'IMG.HEIC', library_id: new ObjectId(), deleted_at: null };
}

function place(p: {
  address?: Partial<Place['address']>;
  rollups?: Partial<Place['rollups']>;
}): Place {
  return {
    source: 'nominatim',
    geocoder_version: 1,
    geocoded_at: '2024-01-01T00:00:00.000Z',
    lat: 0,
    lon: 0,
    display_name: null,
    address: (p.address ?? {}) as Place['address'],
    pois: [],
    rollups: { locality: null, region: null, country_code: null, ...(p.rollups ?? {}) },
    search_blob: '',
  };
}

describe('computeGeoDir', () => {
  test('relocates an old single-segment loc to year/Country/City', () => {
    expect(
      computeGeoDir({
        fileinfo: [fi('2024/Tokyo')],
        place: place({
          address: { country: 'Japan', country_code: 'jp' },
          rollups: { locality: 'Kyoto' },
        }),
      }),
    ).toBe('2024/Japan/Kyoto');
  });

  test('relocates a fallback (date) folder once a place is known (USA → State)', () => {
    expect(
      computeGeoDir({
        fileinfo: [fi('2024/03')],
        place: place({
          address: { state: 'California', country: 'United States', country_code: 'us' },
          rollups: { locality: 'San Francisco', country_code: 'us' },
        }),
      }),
    ).toBe('2024/California/San Francisco');
  });

  test('keeps the year the file already lives under (no cross-year move)', () => {
    // EXIF year differs from the path year — the path wins.
    expect(
      computeGeoDir({
        fileinfo: [fi('2019/Paris')],
        place: place({
          address: { country: 'France', country_code: 'fr' },
          rollups: { locality: 'Paris' },
        }),
        exif: { captured_year: 2024 },
      }),
    ).toBe('2019/France/Paris');
  });

  test('falls back to EXIF year when the path has no 4-digit lead', () => {
    expect(
      computeGeoDir({
        fileinfo: [fi('weird/loc')],
        place: place({
          address: { country: 'France', country_code: 'fr' },
          rollups: { locality: 'Paris' },
        }),
        exif: { captured_year: 2021 },
      }),
    ).toBe('2021/France/Paris');
  });

  test('unresolved stub place → returns current dir (no move; stamp only)', () => {
    expect(computeGeoDir({ fileinfo: [fi('2024/05')], place: place({}) })).toBe('2024/05');
  });

  test('no determinable year → null', () => {
    expect(
      computeGeoDir({
        fileinfo: [fi('weird')],
        place: place({
          address: { country: 'France', country_code: 'fr' },
          rollups: { locality: 'Paris' },
        }),
      }),
    ).toBeNull();
  });

  test('missing fileinfo → null', () => {
    expect(
      computeGeoDir({ place: place({ address: { country: 'France', country_code: 'fr' } }) }),
    ).toBeNull();
  });
});

// ── Mongo-gated end-to-end ──────────────────────────────────────────────────

describe('geo migration end-to-end', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
    stageRegistry._resetForTests();
  });

  it('moves a geocoded backup asset into year/Country/City and stamps the layout', async () => {
    let getDb: typeof import('../../db/client.ts').getDb;
    try {
      ({ getDb } = await import('../../db/client.ts'));
      await getDb();
    } catch {
      console.log('MongoDB unreachable — skipping geo migration end-to-end');
      return;
    }
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { setMigrationEnabled, resetMigrationState } =
      await import('../migration-config.repo.ts');

    const db = await getDb();
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'geo-e2e-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    // Real file in the old single-segment location layout + a sidecar.
    const oldRel = '2024/Tokyo';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'IMG_GEO.HEIC'), 'pixels');
    await fs.writeFile(path.join(dir, oldRel, 'IMG_GEO.xmp'), 'edits');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'geo-e2e-maple-id',
      fileinfo: [{ path: oldRel, filename: 'IMG_GEO.HEIC', library_id: libId, deleted_at: null }],
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
      await resetMigrationState(MIGRATION_ID);
      await setMigrationEnabled(MIGRATION_ID, true, new Date().toISOString());
      await runMigrationTickOnce(50, new Date().toISOString());

      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string; filename: string }[];
        stages?: Record<string, { version: number }>;
        backup_layout_version?: number;
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe('2024/Japan/Kyoto');
      expect(doc?.fileinfo?.[0].filename).toBe('IMG_GEO.HEIC');
      expect(doc?.backup_layout_version).toBe(BACKUP_GEO_LAYOUT_VERSION);
      // Cache stage versions reset so workers regenerate at the new path.
      expect(doc?.stages?.thumb.version).toBe(0);
      expect(doc?.stages?.preview.version).toBe(0);

      // File + sidecar moved; old folder reclaimed.
      expect(await fs.readFile(path.join(dir, '2024/Japan/Kyoto/IMG_GEO.HEIC'), 'utf8')).toBe(
        'pixels',
      );
      expect(await fs.readFile(path.join(dir, '2024/Japan/Kyoto/IMG_GEO.xmp'), 'utf8')).toBe(
        'edits',
      );
      await expect(fs.stat(path.join(dir, oldRel))).rejects.toThrow();

      // Idempotent: a second run finds nothing remaining for this asset.
      const before = await assets.countDocuments({
        _id,
        backup_layout_version: { $ne: BACKUP_GEO_LAYOUT_VERSION },
      });
      expect(before).toBe(0);
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });

  it('already-correct asset is stamped without moving the file (no-op)', async () => {
    let getDb: typeof import('../../db/client.ts').getDb;
    try {
      ({ getDb } = await import('../../db/client.ts'));
      await getDb();
    } catch {
      console.log('MongoDB unreachable — skipping geo migration no-op e2e');
      return;
    }
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { setMigrationEnabled, resetMigrationState } =
      await import('../migration-config.repo.ts');

    const db = await getDb();
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'geo-noop-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    // File already at the geo path it would compute to.
    const rel = '2024/France/Paris';
    await fs.mkdir(path.join(dir, ...rel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, rel, 'IMG_OK.HEIC'), 'pixels');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'geo-noop-maple-id',
      fileinfo: [{ path: rel, filename: 'IMG_OK.HEIC', library_id: libId, deleted_at: null }],
      phasset_links: [{ device_id: 'dev', phasset_local_id: 'ph2', first_seen: new Date() }],
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
      await resetMigrationState(MIGRATION_ID);
      await setMigrationEnabled(MIGRATION_ID, true, new Date().toISOString());
      await runMigrationTickOnce(50, new Date().toISOString());

      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string }[];
        stages?: Record<string, { version: number }>;
        backup_layout_version?: number;
      } | null;
      // Stamped, file untouched, cache versions NOT reset (no move happened).
      expect(doc?.backup_layout_version).toBe(BACKUP_GEO_LAYOUT_VERSION);
      expect(doc?.fileinfo?.[0].path).toBe(rel);
      expect(doc?.stages?.thumb.version).toBe(4);
      expect(await fs.readFile(path.join(dir, rel, 'IMG_OK.HEIC'), 'utf8')).toBe('pixels');
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });
});
