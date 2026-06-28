/**
 * ImportRunner tests. Real temp dirs + real Mongo (skip-pass when
 * unreachable). The indexer hand-off and asset dedup are injected so the
 * test exercises the copy/group/cancel logic without the full pipeline.
 *
 * Covers: groupFiles (pure), end-to-end copy + indexer hand-off (images
 * only), content-dedup skip (image + its sidecar), and cancel-between-files
 * (already-copied files stay).
 */

import { describe, it, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ImportRunner, groupFiles } from './worker.ts';
import type { ImportFileEntry } from '../db/schema.ts';

const TEST_DB = `maple_test_import_worker_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmp: string;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
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

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-import-worker-'));
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[import.worker.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('imports').deleteMany({});
  await db!.collection('import_files').deleteMany({});
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  if (mongo) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {}
    try {
      await mongo.close();
    } catch {}
  }
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

describe('groupFiles', () => {
  test('pairs sidecars to their image and lists movies as bare primaries', () => {
    const files: ImportFileEntry[] = [
      mk('2024/03/IMG.xmp', 'sidecar'),
      mk('2024/03/IMG.dng', 'image'),
      mk('2024/03/clip.mov', 'movie'),
    ];
    const g = groupFiles(files);
    expect(g.primaries).toEqual([1, 2]); // image, movie (sidecar is not primary)
    expect(g.sidecars.get(1)).toEqual([0]);
    expect(g.sidecars.get(2)).toEqual([]);
  });

  // M5 — #1635: video sidecars must pair to their movie.
  test('pairs a sidecar to a movie primary (M5)', () => {
    const files: ImportFileEntry[] = [
      mk('2024/06/clip.xmp', 'sidecar'),
      mk('2024/06/clip.mov', 'movie'),
    ];
    const g = groupFiles(files);
    // clip.mov is the only primary.
    expect(g.primaries).toEqual([1]);
    // clip.xmp (idx 0) attaches to clip.mov (idx 1).
    expect(g.sidecars.get(1)).toEqual([0]);
  });

  test('image wins over movie when both share a stem and a sidecar exists (M5 collision)', () => {
    // clip.jpg, clip.mov, clip.xmp — image appears first in the array
    // (mirrors scan.ts where images are classified before movies in the walk).
    const files: ImportFileEntry[] = [
      mk('2024/06/clip.jpg', 'image'),
      mk('2024/06/clip.mov', 'movie'),
      mk('2024/06/clip.xmp', 'sidecar'),
    ];
    const g = groupFiles(files);
    // Both image and movie are primaries.
    expect(g.primaries.sort()).toEqual([0, 1]);
    // Sidecar attaches to the image (index 0), not the movie (index 1).
    expect(g.sidecars.get(0)).toEqual([2]);
    expect(g.sidecars.get(1)).toEqual([]);
  });
});

function mk(dest: string, kind: ImportFileEntry['kind']): ImportFileEntry {
  return { src: '', dest, size: 1, mtime: 0, kind, state: 'pending', error: null };
}

/** Stage source files in a fresh src dir; return their absolute paths. */
async function stageSources(sub: string, names: string[]): Promise<Record<string, string>> {
  const dir = path.join(tmp, sub, 'src');
  await fs.mkdir(dir, { recursive: true });
  const out: Record<string, string> = {};
  for (const n of names) {
    const abs = path.join(dir, n);
    await fs.writeFile(abs, `bytes-${sub}-${n}`);
    out[n] = abs;
  }
  return out;
}

describe('ImportRunner.tick', () => {
  it('auto import: the worker scans the source and copies (scan_pending)', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');
    const src = await stageSources('auto', ['IMG.dng', 'IMG.xmp']);
    // Known mtime → deterministic YEAR/MM bucket.
    const when = new Date('2024-03-09T12:00:00Z');
    await fs.utimes(src['IMG.dng'], when, when);
    await fs.utimes(src['IMG.xmp'], when, when);
    const lib = path.join(tmp, 'auto', 'lib');

    const created = await repo.createImport({
      source_root: path.join(tmp, 'auto', 'src'),
      library_id: new ObjectId(),
      library_root: lib,
      files: [], // no files up front — worker scans
      scan_pending: true,
    });

    let handed = 0;
    const runner = new ImportRunner({
      workerId: 'w-auto',
      deps: {
        assetExistsForHash: async () => false,
        handleEvent: async () => {
          handed++;
        },
      },
    });
    expect((await runner.tick()).kind).toBe('done');

    // Worker scanned + filed everything under <year>/<MM>/.
    expect(await fs.readFile(path.join(lib, '2024/03/IMG.dng'), 'utf8')).toBe('bytes-auto-IMG.dng');
    expect(await fs.readFile(path.join(lib, '2024/03/IMG.xmp'), 'utf8')).toBe('bytes-auto-IMG.xmp');
    expect(handed).toBe(1); // the image was handed to the indexer

    const doc = await repo.getImport(created._id);
    expect(doc!.status).toBe('done');
    expect(doc!.scan_pending).toBe(false);
    expect(doc!.progress.total).toBe(2); // image + sidecar
    expect(doc!.counts.copied).toBe(2);
  });

  it('auto import whose source has no importable files is marked failed', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');
    // A source folder with only a non-media file → nothing to import.
    const dir = path.join(tmp, 'auto-empty', 'src');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'notes.txt'), 'not a photo');
    const lib = path.join(tmp, 'auto-empty', 'lib');

    const created = await repo.createImport({
      source_root: dir,
      library_id: new ObjectId(),
      library_root: lib,
      files: [],
      scan_pending: true,
    });

    const runner = new ImportRunner({
      workerId: 'w-auto-empty',
      deps: {
        assetExistsForHash: async () => false,
        handleEvent: async () => {},
      },
    });
    const res = await runner.tick();
    expect(res.kind).toBe('failed');

    const doc = await repo.getImport(created._id);
    expect(doc!.status).toBe('failed');
    expect(doc!.error).toBeTruthy(); // explains there were no importable files
    expect(await repo.getImportFiles(created._id)).toHaveLength(0);
    // Nothing was copied; the library dir was never created.
    await expect(fs.stat(lib)).rejects.toThrow();
  });

  it('copies files, hands images (not movies) to the indexer', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');
    const src = await stageSources('happy', ['IMG.dng', 'IMG.xmp', 'clip.mov']);
    const lib = path.join(tmp, 'happy', 'lib');
    const libId = new ObjectId();

    await repo.createImport({
      source_root: path.join(tmp, 'happy', 'src'),
      library_id: libId,
      library_root: lib,
      files: [
        entry(src['IMG.xmp'], '2024/03/IMG.xmp', 'sidecar'),
        entry(src['IMG.dng'], '2024/03/IMG.dng', 'image'),
        entry(src['clip.mov'], '2024/03/clip.mov', 'movie'),
      ],
    });

    const handed: { absPath: string; folderId: string }[] = [];
    const runner = new ImportRunner({
      workerId: 'w-happy',
      deps: {
        assetExistsForHash: async () => false,
        handleEvent: async (ev, folderId) => {
          handed.push({
            absPath: (ev as { absPath: string }).absPath,
            folderId: folderId.toHexString(),
          });
        },
      },
    });

    const res = await runner.tick();
    expect(res.kind).toBe('done');

    // All three landed on disk.
    expect(await fs.readFile(path.join(lib, '2024/03/IMG.dng'), 'utf8')).toBe(
      'bytes-happy-IMG.dng',
    );
    expect(await fs.readFile(path.join(lib, '2024/03/IMG.xmp'), 'utf8')).toBe(
      'bytes-happy-IMG.xmp',
    );
    expect(await fs.readFile(path.join(lib, '2024/03/clip.mov'), 'utf8')).toBe(
      'bytes-happy-clip.mov',
    );

    // Indexer hand-off only for the image, with the library id as folderId.
    expect(handed).toHaveLength(1);
    expect(handed[0].absPath).toBe(path.join(lib, '2024/03/IMG.dng'));
    expect(handed[0].folderId).toBe(libId.toHexString());

    const doc = (await repo.listImports({}))[0];
    expect(doc.status).toBe('done');
    expect(doc.counts).toEqual({ copied: 3, skipped: 0, failed: 0 });
    expect(doc.progress).toEqual({ current: 3, total: 3 });
  });

  it('skips a duplicate image and its sidecar', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');
    const src = await stageSources('dup', ['IMG.dng', 'IMG.xmp']);
    const lib = path.join(tmp, 'dup', 'lib');

    await repo.createImport({
      source_root: path.join(tmp, 'dup', 'src'),
      library_id: new ObjectId(),
      library_root: lib,
      files: [
        entry(src['IMG.xmp'], '2024/03/IMG.xmp', 'sidecar'),
        entry(src['IMG.dng'], '2024/03/IMG.dng', 'image'),
      ],
    });

    let handed = 0;
    const runner = new ImportRunner({
      workerId: 'w-dup',
      deps: {
        assetExistsForHash: async () => true, // already in the library
        handleEvent: async () => {
          handed++;
        },
      },
    });
    const res = await runner.tick();
    expect(res.kind).toBe('done');

    // Nothing copied; no indexer hand-off.
    await expect(fs.stat(path.join(lib, '2024/03/IMG.dng'))).rejects.toThrow();
    expect(handed).toBe(0);

    const doc = (await repo.listImports({}))[0];
    expect(doc.counts).toEqual({ copied: 0, skipped: 2, failed: 0 });
  });

  it('keeps a sidecar paired to its image after a collision rename', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');
    const src = await stageSources('collide', ['IMG.dng', 'IMG.xmp']);
    const lib = path.join(tmp, 'collide', 'lib');
    // A DIFFERENT photo already occupies the computed image path.
    await fs.mkdir(path.join(lib, '2024/03'), { recursive: true });
    await fs.writeFile(path.join(lib, '2024/03/IMG.dng'), 'a different photo');

    await repo.createImport({
      source_root: path.join(tmp, 'collide', 'src'),
      library_id: new ObjectId(),
      library_root: lib,
      files: [
        entry(src['IMG.xmp'], '2024/03/IMG.xmp', 'sidecar'),
        entry(src['IMG.dng'], '2024/03/IMG.dng', 'image'),
      ],
    });

    const handed: string[] = [];
    const runner = new ImportRunner({
      workerId: 'w-collide',
      deps: {
        assetExistsForHash: async () => false,
        handleEvent: async (ev) => {
          handed.push((ev as { absPath: string }).absPath);
        },
      },
    });
    expect((await runner.tick()).kind).toBe('done');

    // Image renamed to IMG-1.dng; the sidecar follows to IMG-1.xmp, NOT IMG.xmp.
    expect(await fs.readFile(path.join(lib, '2024/03/IMG-1.dng'), 'utf8')).toBe(
      'bytes-collide-IMG.dng',
    );
    expect(await fs.readFile(path.join(lib, '2024/03/IMG-1.xmp'), 'utf8')).toBe(
      'bytes-collide-IMG.xmp',
    );
    await expect(fs.stat(path.join(lib, '2024/03/IMG.xmp'))).rejects.toThrow();
    expect(handed).toEqual([path.join(lib, '2024/03/IMG-1.dng')]);
  });

  it('cancels between files, leaving already-copied files in place', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');
    const src = await stageSources('cancel', ['A.dng', 'B.dng']);
    const lib = path.join(tmp, 'cancel', 'lib');

    const created = await repo.createImport({
      source_root: path.join(tmp, 'cancel', 'src'),
      library_id: new ObjectId(),
      library_root: lib,
      files: [
        entry(src['A.dng'], '2024/03/A.dng', 'image'),
        entry(src['B.dng'], '2024/03/B.dng', 'image'),
      ],
    });

    const runner = new ImportRunner({
      workerId: 'w-cancel',
      deps: {
        assetExistsForHash: async () => false,
        // After the first image is handed off, request cancel — the second
        // image's pre-loop cancel check should then fire.
        handleEvent: async () => {
          await repo.requestImportCancel(created._id);
        },
      },
    });

    const res = await runner.tick();
    expect(res.kind).toBe('cancelled');

    // First image copied and stays; second never copied.
    expect(await fs.readFile(path.join(lib, '2024/03/A.dng'), 'utf8')).toBe('bytes-cancel-A.dng');
    await expect(fs.stat(path.join(lib, '2024/03/B.dng'))).rejects.toThrow();

    const doc = await repo.getImport(created._id);
    expect(doc!.status).toBe('cancelled');
    expect(doc!.counts.copied).toBe(1);
  });

  it('skips a pre-failed file (no copy) and completes done with the good one (#795)', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');
    const src = await stageSources('prefailed', ['GOOD.dng']);
    const lib = path.join(tmp, 'prefailed', 'lib');

    // BAD.dng is already `failed` (e.g. the scan couldn't build a safe dest);
    // its `src` points at a path that does not exist, so a stray copy attempt
    // would surface as a DIFFERENT error than the recorded one.
    const badFailed: ImportFileEntry = {
      src: path.join(tmp, 'prefailed', 'src', 'does-not-exist.dng'),
      dest: '2024/03/BAD.dng',
      size: 1,
      mtime: 0,
      kind: 'image',
      state: 'failed',
      error: 'unsafe filename: "BAD.dng"',
    };

    const created = await repo.createImport({
      source_root: path.join(tmp, 'prefailed', 'src'),
      library_id: new ObjectId(),
      library_root: lib,
      files: [badFailed, entry(src['GOOD.dng'], '2024/03/GOOD.dng', 'image')],
    });

    const runner = new ImportRunner({
      workerId: 'w-prefailed',
      deps: {
        assetExistsForHash: async () => false,
        handleEvent: async () => {},
      },
    });
    const res = await runner.tick();
    expect(res.kind).toBe('done');

    const doc = await repo.getImport(created._id);
    expect(doc!.status).toBe('done');
    expect(doc!.counts.copied).toBe(1);
    expect(doc!.counts.failed).toBe(1);
    // The pre-failed file kept its ORIGINAL recorded reason — never re-copied.
    const files = await repo.getImportFiles(created._id);
    expect(files[0].state).toBe('failed');
    expect(files[0].error).toBe('unsafe filename: "BAD.dng"');
    // The good file landed on disk.
    expect(await fs.readFile(path.join(lib, '2024/03/GOOD.dng'), 'utf8')).toBe(
      'bytes-prefailed-GOOD.dng',
    );
  });

  it('marks an import failed when every file failed (#795)', async () => {
    if (!mongoReachable) return;
    const repo = await import('./repo.ts');
    const lib = path.join(tmp, 'allfailed', 'lib');

    const onlyFailed: ImportFileEntry = {
      src: '/nope/missing.dng',
      dest: '2024/03/BAD.dng',
      size: 1,
      mtime: 0,
      kind: 'image',
      state: 'failed',
      error: 'unsafe filename: "BAD.dng"',
    };

    const created = await repo.createImport({
      source_root: path.join(tmp, 'allfailed', 'src'),
      library_id: new ObjectId(),
      library_root: lib,
      files: [onlyFailed],
    });

    const runner = new ImportRunner({
      workerId: 'w-allfailed',
      deps: {
        assetExistsForHash: async () => false,
        handleEvent: async () => {},
      },
    });
    const res = await runner.tick();
    expect(res.kind).toBe('failed');

    const doc = await repo.getImport(created._id);
    expect(doc!.status).toBe('failed');
    expect(doc!.error).toBeTruthy();
    expect(doc!.counts.failed).toBe(1);
    // Nothing was copied; the library dir was never created.
    await expect(fs.stat(lib)).rejects.toThrow();
  });
});

function entry(src: string, dest: string, kind: ImportFileEntry['kind']): ImportFileEntry {
  return { src, dest, size: 1, mtime: 0, kind, state: 'pending', error: null };
}
