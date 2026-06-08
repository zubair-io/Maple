/**
 * Tests for the screenshot folder migration.
 *
 *  - candidateFilter selection is exercised end-to-end via runBatch.
 *  - End-to-end runBatch: seeds a backup-origin screenshot with a real temp
 *    file and drives one tick. Skips when MongoDB is unreachable (mirrors
 *    restructure-backup-geo.test.ts / migration.test.ts).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import { stageRegistry } from '../registry.ts';
import { runMigrationTickOnce } from '../migration.ts';
import { relocateBackupScreenshot } from './restructure-backup-screenshots.ts';

const MIGRATION_ID = 'restructure-backup-screenshots';

describe('screenshot migration end-to-end', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
    stageRegistry._resetForTests();
  });

  it('moves a flagged backup screenshot into year/Screenshot', async () => {
    let getDb: typeof import('../../db/client.ts').getDb;
    try {
      ({ getDb } = await import('../../db/client.ts'));
      await getDb();
    } catch {
      console.log('MongoDB unreachable — skipping screenshot migration end-to-end');
      return;
    }
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { setMigrationEnabled, resetMigrationState } =
      await import('../migration-config.repo.ts');

    const db = await getDb();
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shot-e2e-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    // A screenshot currently filed in the date-only fallback folder, plus a
    // paired sidecar to prove companions move with it.
    const oldRel = '2024/03';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, 'Screenshot 2024-03-15.png'), 'pixels');
    await fs.writeFile(path.join(dir, oldRel, 'Screenshot 2024-03-15.xmp'), 'edits');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'shot-e2e-maple-id',
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
      await resetMigrationState(MIGRATION_ID);
      await setMigrationEnabled(MIGRATION_ID, true, new Date().toISOString());
      await runMigrationTickOnce(50, new Date().toISOString());

      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string; filename: string }[];
        stages?: Record<string, { version: number }>;
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe('2024/Screenshot');
      expect(doc?.fileinfo?.[0].filename).toBe('Screenshot 2024-03-15.png');
      // Cache stage versions reset so workers regenerate at the new path.
      expect(doc?.stages?.thumb.version).toBe(0);
      expect(doc?.stages?.preview.version).toBe(0);

      // File + sidecar moved; old folder reclaimed.
      expect(
        await fs.readFile(path.join(dir, '2024/Screenshot/Screenshot 2024-03-15.png'), 'utf8'),
      ).toBe('pixels');
      expect(
        await fs.readFile(path.join(dir, '2024/Screenshot/Screenshot 2024-03-15.xmp'), 'utf8'),
      ).toBe('edits');
      await expect(fs.stat(path.join(dir, oldRel))).rejects.toThrow();

      // Idempotent: a second tick leaves the now-filed screenshot exactly where
      // it is (it no longer matches the candidate filter).
      await runMigrationTickOnce(50, new Date().toISOString());
      const doc2 = (await assets.findOne({ _id })) as { fileinfo?: { path: string }[] } | null;
      expect(doc2?.fileinfo?.[0].path).toBe('2024/Screenshot');
      expect(
        await fs.readFile(path.join(dir, '2024/Screenshot/Screenshot 2024-03-15.png'), 'utf8'),
      ).toBe('pixels');
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });

  it('leaves a non-screenshot backup asset untouched', async () => {
    let getDb: typeof import('../../db/client.ts').getDb;
    try {
      ({ getDb } = await import('../../db/client.ts'));
      await getDb();
    } catch {
      console.log('MongoDB unreachable — skipping screenshot migration no-op e2e');
      return;
    }
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const { setMigrationEnabled, resetMigrationState } =
      await import('../migration-config.repo.ts');

    const db = await getDb();
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shot-noop-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    const rel = '2024/03';
    await fs.mkdir(path.join(dir, ...rel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, rel, 'IMG_REAL.HEIC'), 'pixels');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'shot-noop-maple-id',
      fileinfo: [{ path: rel, filename: 'IMG_REAL.HEIC', library_id: libId, deleted_at: null }],
      phasset_links: [{ device_id: 'dev', phasset_local_id: 'ph2', first_seen: new Date() }],
      is_screenshot: false,
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
    } as never);

    try {
      await resetMigrationState(MIGRATION_ID);
      await setMigrationEnabled(MIGRATION_ID, true, new Date().toISOString());
      await runMigrationTickOnce(50, new Date().toISOString());

      const doc = (await assets.findOne({ _id })) as { fileinfo?: { path: string }[] } | null;
      // Not a screenshot → left exactly where it was.
      expect(doc?.fileinfo?.[0].path).toBe(rel);
      expect(await fs.readFile(path.join(dir, rel, 'IMG_REAL.HEIC'), 'utf8')).toBe('pixels');
    } finally {
      await assets.deleteOne({ _id });
      await resetMigrationState(MIGRATION_ID);
      setLibraryRootsForTests(null);
    }
  });
});

// ── describe-stage hook (relocateBackupScreenshot) ──────────────────────────
// The describe stage calls this when the qwen verdict flags a screenshot the
// ingest filename heuristic missed. It does NOT re-check is_screenshot (the
// field isn't persisted until after the describe handler returns) — it trusts
// the caller's verdict and only checks backup-origin + folder.

describe('relocateBackupScreenshot (describe-stage hook)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
  });

  async function connectOrSkip(
    label: string,
  ): Promise<Awaited<ReturnType<typeof import('../../db/client.ts').getDb>> | null> {
    try {
      const { getDb } = await import('../../db/client.ts');
      return await getDb();
    } catch {
      console.log(`MongoDB unreachable — skipping ${label}`);
      return null;
    }
  }

  it('files a backup screenshot the ingest heuristic missed into year/Screenshot', async () => {
    const db = await connectOrSkip('relocate e2e');
    if (!db) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shot-reloc-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    const oldRel = '2024/03';
    await fs.mkdir(path.join(dir, ...oldRel.split('/')), { recursive: true });
    // An iOS capture whose filename the ingest heuristic doesn't match.
    await fs.writeFile(path.join(dir, oldRel, 'IMG_4523.PNG'), 'pixels');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'reloc-e2e-maple-id',
      fileinfo: [{ path: oldRel, filename: 'IMG_4523.PNG', library_id: libId, deleted_at: null }],
      phasset_links: [{ device_id: 'dev', phasset_local_id: 'ph', first_seen: new Date() }],
      // Still false on disk — relocate trusts the caller's verdict, not this.
      is_screenshot: false,
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      stages: { thumb: { version: 1 }, preview: { version: 1 } },
    } as never);

    try {
      expect(await relocateBackupScreenshot(_id)).toBe('moved');
      const doc = (await assets.findOne({ _id })) as { fileinfo?: { path: string }[] } | null;
      expect(doc?.fileinfo?.[0].path).toBe('2024/Screenshot');
      expect(await fs.readFile(path.join(dir, '2024/Screenshot/IMG_4523.PNG'), 'utf8')).toBe(
        'pixels',
      );
    } finally {
      await assets.deleteOne({ _id });
      setLibraryRootsForTests(null);
    }
  });

  it('is not-applicable for a non-backup asset (no phasset_links)', async () => {
    const db = await connectOrSkip('relocate non-backup e2e');
    if (!db) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shot-reloc-nb-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    const rel = '2024/03';
    await fs.mkdir(path.join(dir, ...rel.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, rel, 'IMG_X.PNG'), 'pixels');

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'reloc-nb-maple-id',
      fileinfo: [{ path: rel, filename: 'IMG_X.PNG', library_id: libId, deleted_at: null }],
      // No phasset_links → not backup-origin → left to the user's layout.
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
    } as never);

    try {
      expect(await relocateBackupScreenshot(_id)).toBe('not-applicable');
      const doc = (await assets.findOne({ _id })) as { fileinfo?: { path: string }[] } | null;
      expect(doc?.fileinfo?.[0].path).toBe(rel);
    } finally {
      await assets.deleteOne({ _id });
      setLibraryRootsForTests(null);
    }
  });

  it('is not-applicable when already filed under year/Screenshot', async () => {
    const db = await connectOrSkip('relocate already-filed e2e');
    if (!db) return;
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    const assets = db.collection('assets');
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shot-reloc-af-'));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: 'reloc-af-maple-id',
      fileinfo: [
        { path: '2024/Screenshot', filename: 'IMG_Y.PNG', library_id: libId, deleted_at: null },
      ],
      phasset_links: [{ device_id: 'dev', phasset_local_id: 'ph3', first_seen: new Date() }],
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
    } as never);

    try {
      expect(await relocateBackupScreenshot(_id)).toBe('not-applicable');
    } finally {
      await assets.deleteOne({ _id });
      setLibraryRootsForTests(null);
    }
  });
});
