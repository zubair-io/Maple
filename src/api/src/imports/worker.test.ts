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
});

function entry(src: string, dest: string, kind: ImportFileEntry['kind']): ImportFileEntry {
  return { src, dest, size: 1, mtime: 0, kind, state: 'pending', error: null };
}
