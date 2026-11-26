/**
 * A movie is content-deduplicated like a photo (#5635). Real temp directories,
 * a real private SQLite database per test and the real hash and catalog
 * lookups: only the indexer hand-off is stubbed. The library's catalog rows are
 * seeded from the library file's own hash, the way the discover sweep writes
 * them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { hashFileForId } from '../indexer/id.ts';
import { recordedAttempt } from '../temporal/recorded-attempt.test-helpers.ts';
import * as repo from './repo.ts';
import { ImportRunner, type ImportRunnerDeps } from './worker.ts';

let tmp: string;
let previousMapleRoots: string | undefined;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-import-movie-dup-'));
  previousMapleRoots = process.env.MAPLE_ROOTS;
  process.env.MAPLE_ROOTS = await fs.realpath(os.tmpdir());
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  if (previousMapleRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = previousMapleRoots;
});

const MOVIE_BYTES = 'the same movie, byte for byte';

interface Scenario {
  lib: string;
  libId: ObjectId;
  srcDir: string;
}

async function scenario(db: Database, name: string, sourceFolder: string): Promise<Scenario> {
  const lib = path.join(tmp, name, 'lib');
  await fs.mkdir(lib, { recursive: true });
  const srcDir = path.join(tmp, name, sourceFolder);
  await fs.mkdir(srcDir, { recursive: true });
  return { lib, libId: new ObjectId(insertFolder(db, { path: lib })), srcDir };
}

interface Seeded {
  assetDeletedAt?: string;
  locationDeletedAt?: string;
  missingSince?: string;
  locationLibraryId?: string;
  mapleId?: string;
  catalogPath?: string;
  linkTo?: string;
}

async function seedIndexedMovie(
  db: Database,
  s: Scenario,
  relPath: string,
  bytes: string,
  seeded: Seeded = {},
): Promise<{ abs: string; mtimeMs: number }> {
  const abs = path.join(s.lib, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  if (seeded.linkTo === undefined) await fs.writeFile(abs, bytes);
  else await fs.symlink(seeded.linkTo, abs);
  const hashed = await hashFileForId(abs);
  const assetId = insertAsset(db, { deletedAt: seeded.assetDeletedAt ?? null });
  run(
    db,
    `UPDATE assets SET maple_id = ?, sha1_head = ? WHERE id = ?`,
    seeded.mapleId ?? hashed.maple_id,
    hashed.sha1_head,
    assetId,
  );
  const dir = seeded.catalogPath ?? (path.dirname(relPath) === '.' ? '' : path.dirname(relPath));
  insertLocation(db, {
    assetId,
    libraryId: seeded.locationLibraryId ?? s.libId.toHexString(),
    path: dir,
    filename: path.basename(relPath),
    deletedAt: seeded.locationDeletedAt ?? null,
    missingSince: seeded.missingSince ?? null,
  });
  return { abs, mtimeMs: (await fs.stat(abs)).mtimeMs };
}

async function importFolder(
  s: Scenario,
  runId: string,
  sourceFiles: Record<string, string>,
  deps: Partial<ImportRunnerDeps> = {},
) {
  for (const [name, bytes] of Object.entries(sourceFiles)) {
    await fs.writeFile(path.join(s.srcDir, name), bytes);
  }
  const created = await repo.createImport({
    source_root: s.srcDir,
    library_id: s.libId,
    library_root: s.lib,
    files: [],
    scan_pending: true,
  });
  const runner = new ImportRunner({ deps: { handleEvent: async () => {}, ...deps } });
  const result = await runner.run(created._id.toHexString(), recordedAttempt(runId));
  const doc = await repo.getImport(created._id);
  return {
    outcome: result.outcome,
    counts: doc!.counts,
    files: await repo.getImportFiles(created._id),
  };
}

async function libraryFiles(lib: string): Promise<string[]> {
  const entries = await fs.readdir(lib, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(lib, path.join(e.parentPath, e.name)))
    .sort();
}

describe('import: a movie the library already holds', () => {
  it('is skipped when the same card arrives from a differently named folder, leaving the library file alone', async () => {
    using live = await createLiveTestDatabase();
    const s = await scenario(live.db, 'reported', 'card-two');
    const held = await seedIndexedMovie(live.db, s, '2024/misc/card-one/clip.mov', MOVIE_BYTES);

    const res = await importFolder(s, 'w-reported', { 'clip.mov': MOVIE_BYTES });

    expect(res.outcome).toBe('done');
    expect(res.counts).toEqual({ copied: 0, skipped: 1, failed: 0 });
    expect(res.files.map((f) => f.state)).toEqual(['skipped_duplicate']);
    expect(await libraryFiles(s.lib)).toEqual(['2024/misc/card-one/clip.mov']);
    expect(await fs.readFile(held.abs, 'utf8')).toBe(MOVIE_BYTES);
    expect((await fs.stat(held.abs)).mtimeMs).toBe(held.mtimeMs);
  });

  it('is skipped whatever the source file is called, and takes its sidecar with it', async () => {
    using live = await createLiveTestDatabase();
    const s = await scenario(live.db, 'renamed', 'card-two');
    await seedIndexedMovie(live.db, s, '2024/misc/card-one/clip.mov', MOVIE_BYTES);

    const res = await importFolder(s, 'w-renamed', {
      'C0042.mov': MOVIE_BYTES,
      'C0042.mov.xmp': '<x:xmpmeta/>',
    });

    expect(res.counts).toEqual({ copied: 0, skipped: 2, failed: 0 });
    expect(await libraryFiles(s.lib)).toEqual(['2024/misc/card-one/clip.mov']);
  });

  it('is copied when only its name matches a catalogued movie', async () => {
    using live = await createLiveTestDatabase();
    const s = await scenario(live.db, 'same-name', 'card-two');
    await seedIndexedMovie(live.db, s, '2024/misc/card-one/clip.mov', MOVIE_BYTES);

    const res = await importFolder(s, 'w-same-name', { 'clip.mov': 'a different movie' });

    expect(res.counts).toEqual({ copied: 1, skipped: 0, failed: 0 });
    expect((await libraryFiles(s.lib)).length).toBe(2);
  });

  const unusableRows: [string, Seeded][] = [
    ['its location is marked missing', { missingSince: '2026-01-01T00:00:00.000Z' }],
    ['its location is in the trash', { locationDeletedAt: '2026-01-01T00:00:00.000Z' }],
    ['the asset is in the trash', { assetDeletedAt: '2026-01-01T00:00:00.000Z' }],
  ];
  for (const [why, seeded] of unusableRows) {
    it(`is copied when the catalog row matches but ${why}`, async () => {
      using live = await createLiveTestDatabase();
      const s = await scenario(live.db, `stale-${why.replaceAll(' ', '-')}`, 'card-two');
      await seedIndexedMovie(live.db, s, '2024/misc/card-one/clip.mov', MOVIE_BYTES, seeded);

      const res = await importFolder(s, 'w-stale', { 'clip.mov': MOVIE_BYTES });

      expect(res.counts).toEqual({ copied: 1, skipped: 0, failed: 0 });
      expect((await libraryFiles(s.lib)).some((f) => f.endsWith('/misc/card-two/clip.mov'))).toBe(
        true,
      );
    });
  }

  describe('when only the first 64 KB agrees', () => {
    const head = 'h'.repeat(64 * 1024);

    it('copies a different movie of the same size', async () => {
      using live = await createLiveTestDatabase();
      const s = await scenario(live.db, 'same-head-same-size', 'card-two');
      const held = await seedIndexedMovie(live.db, s, '2024/misc/card-one/a.mov', `${head}first`);

      const res = await importFolder(s, 'w-head-size', { 'b.mov': `${head}other` });

      expect(res.counts).toEqual({ copied: 1, skipped: 0, failed: 0 });
      expect(await fs.readFile(held.abs, 'utf8')).toBe(`${head}first`);
      expect((await libraryFiles(s.lib)).length).toBe(2);
    });

    it('copies a different movie of another size', async () => {
      using live = await createLiveTestDatabase();
      const s = await scenario(live.db, 'same-head-other-size', 'card-two');
      await seedIndexedMovie(live.db, s, '2024/misc/card-one/a.mov', `${head}first`);

      const res = await importFolder(s, 'w-head-other', { 'b.mov': `${head}a longer tail` });

      expect(res.counts).toEqual({ copied: 1, skipped: 0, failed: 0 });
    });
  });

  it('is copied when the catalog still lists the file but it was deleted from disk', async () => {
    using live = await createLiveTestDatabase();
    const s = await scenario(live.db, 'deleted-on-disk', 'card-two');
    const held = await seedIndexedMovie(live.db, s, '2024/misc/card-one/clip.mov', MOVIE_BYTES);
    await fs.rm(held.abs);

    const res = await importFolder(s, 'w-deleted', { 'clip.mov': MOVIE_BYTES });

    expect(res.counts).toEqual({ copied: 1, skipped: 0, failed: 0 });
    expect(await libraryFiles(s.lib)).toEqual(['2026/misc/card-two/clip.mov']);
  });

  it('is copied, and the import does not fail, when the candidate file cannot be read', async () => {
    using live = await createLiveTestDatabase();
    const s = await scenario(live.db, 'unreadable-candidate', 'card-two');
    const held = await seedIndexedMovie(live.db, s, '2024/misc/card-one/clip.mov', MOVIE_BYTES);
    await fs.chmod(held.abs, 0o000);

    try {
      const res = await importFolder(s, 'w-unreadable-candidate', { 'clip.mov': MOVIE_BYTES });
      expect(res.outcome).toBe('done');
      expect(res.counts).toEqual({ copied: 1, skipped: 0, failed: 0 });
    } finally {
      await fs.chmod(held.abs, 0o644);
    }
  });

  it('is skipped when the catalog id is not the whole-file id, as after the exif stage rewrites it', async () => {
    using live = await createLiveTestDatabase();
    const s = await scenario(live.db, 'rewritten-id', 'card-two');
    await seedIndexedMovie(live.db, s, '2024/misc/card-one/clip.mov', MOVIE_BYTES, {
      mapleId: `01${'f'.repeat(30)}`,
    });

    const res = await importFolder(s, 'w-rewritten', { 'clip.mov': MOVIE_BYTES });

    expect(res.counts).toEqual({ copied: 0, skipped: 1, failed: 0 });
  });

  it('is skipped when the matching file sits at the library root', async () => {
    using live = await createLiveTestDatabase();
    const s = await scenario(live.db, 'at-root', 'card-two');
    await seedIndexedMovie(live.db, s, 'clip.mov', MOVIE_BYTES);

    const res = await importFolder(s, 'w-root', { 'other.mov': MOVIE_BYTES });

    expect(res.counts).toEqual({ copied: 0, skipped: 1, failed: 0 });
  });

  it('is copied when the catalog path climbs out of the library with ..', async () => {
    using live = await createLiveTestDatabase();
    const s = await scenario(live.db, 'dotdot', 'card-two');
    await fs.mkdir(path.join(tmp, 'dotdot', 'outside'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'dotdot', 'outside', 'clip.mov'), MOVIE_BYTES);
    await seedIndexedMovie(live.db, s, '2024/misc/card-one/clip.mov', MOVIE_BYTES, {
      catalogPath: '../outside',
    });
    await fs.rm(path.join(s.lib, '2024/misc/card-one/clip.mov'));

    const res = await importFolder(s, 'w-dotdot', { 'clip.mov': MOVIE_BYTES });

    expect(res.counts).toEqual({ copied: 1, skipped: 0, failed: 0 });
  });

  it('is copied when the candidate is a link to a file outside the library', async () => {
    using live = await createLiveTestDatabase();
    const s = await scenario(live.db, 'symlink', 'card-two');
    const outside = path.join(tmp, 'symlink', 'elsewhere.mov');
    await fs.writeFile(outside, MOVIE_BYTES);
    await seedIndexedMovie(live.db, s, '2024/misc/card-one/clip.mov', MOVIE_BYTES, {
      linkTo: outside,
    });

    const res = await importFolder(s, 'w-symlink', { 'clip.mov': MOVIE_BYTES });

    expect(res.counts).toEqual({ copied: 1, skipped: 0, failed: 0 });
  });

  describe('how many whole files are read', () => {
    const head = 'h'.repeat(64 * 1024);
    const counting = () => {
      const hashed: string[] = [];
      const deps: Partial<ImportRunnerDeps> = {
        hashFileForId: async (abs) => {
          hashed.push(abs);
          return hashFileForId(abs);
        },
      };
      return { hashed, deps };
    };

    it('reads none for a movie the catalog has no candidate for', async () => {
      using live = await createLiveTestDatabase();
      const s = await scenario(live.db, 'no-candidate', 'card-two');
      const { hashed, deps } = counting();

      const res = await importFolder(s, 'w-none', { 'clip.mov': MOVIE_BYTES }, deps);

      expect(res.counts).toEqual({ copied: 1, skipped: 0, failed: 0 });
      expect(hashed).toEqual([]);
    });

    it('reads none when same-head candidates all differ in size', async () => {
      using live = await createLiveTestDatabase();
      const s = await scenario(live.db, 'size-only', 'card-two');
      await seedIndexedMovie(live.db, s, '2024/a/a.mov', `${head}1`);
      const { hashed, deps } = counting();

      const res = await importFolder(s, 'w-size-only', { 'b.mov': `${head}22` }, deps);

      expect(res.counts).toEqual({ copied: 1, skipped: 0, failed: 0 });
      expect(hashed).toEqual([]);
    });

    it('finds the duplicate behind many same-head clips of other sizes', async () => {
      using live = await createLiveTestDatabase();
      const s = await scenario(live.db, 'many-sizes', 'card-two');
      for (let n = 0; n < 5; n += 1) {
        await seedIndexedMovie(live.db, s, `2024/a/clip-${n}.mov`, `${head}${'x'.repeat(n + 10)}`);
      }
      await seedIndexedMovie(live.db, s, '2024/z/clip.mov', `${head}real`);
      const { hashed, deps } = counting();

      const res = await importFolder(s, 'w-many-sizes', { 'c.mov': `${head}real` }, deps);

      expect(res.counts).toEqual({ copied: 0, skipped: 1, failed: 0 });
      expect(hashed.length).toBe(2);
    });

    it('stops after three whole-file reads of same-size look-alikes', async () => {
      using live = await createLiveTestDatabase();
      const s = await scenario(live.db, 'many-same-size', 'card-two');
      for (let n = 0; n < 4; n += 1) {
        await seedIndexedMovie(live.db, s, `2024/a/clip-${n}.mov`, `${head}f${n}ke`);
      }
      await seedIndexedMovie(live.db, s, '2024/z/clip.mov', `${head}real`);
      const { hashed, deps } = counting();

      const res = await importFolder(s, 'w-many-same', { 'c.mov': `${head}real` }, deps);

      expect(res.counts).toEqual({ copied: 1, skipped: 0, failed: 0 });
      expect(hashed.length).toBe(4);
    });
  });

  it('is copied when the matching movie lives only in another library', async () => {
    using live = await createLiveTestDatabase();
    const s = await scenario(live.db, 'other-library', 'card-two');
    const otherLibraryId = insertFolder(live.db, {
      path: path.join(tmp, 'other-library', 'other'),
    });
    await seedIndexedMovie(live.db, s, '2024/misc/card-one/clip.mov', MOVIE_BYTES, {
      locationLibraryId: otherLibraryId,
    });

    const res = await importFolder(s, 'w-other-library', { 'clip.mov': MOVIE_BYTES });

    expect(res.counts).toEqual({ copied: 1, skipped: 0, failed: 0 });
  });

  it('fails the file, without copying or skipping it, when its content cannot be hashed', async () => {
    using live = await createLiveTestDatabase();
    const s = await scenario(live.db, 'unreadable', 'card-two');
    await seedIndexedMovie(live.db, s, '2024/misc/card-one/clip.mov', MOVIE_BYTES);

    const res = await importFolder(
      s,
      'w-unreadable',
      { 'clip.mov': MOVIE_BYTES },
      {
        hashFileForId: async () => {
          throw new Error('EACCES: permission denied');
        },
      },
    );

    expect(res.counts).toEqual({ copied: 0, skipped: 0, failed: 1 });
    expect(res.files.map((f) => f.state)).toEqual(['failed']);
    expect(await libraryFiles(s.lib)).toEqual(['2024/misc/card-one/clip.mov']);
  });
});
