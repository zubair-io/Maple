/**
 * ImportRunner tests. Real temp dirs, real file copies, and a private SQLite
 * database per test (#3787). The indexer hand-off and asset dedup are injected
 * so the test exercises the copy/group/cancel logic without the full pipeline.
 *
 * Covers: groupFiles (pure), end-to-end copy + indexer hand-off (images
 * only), content-dedup skip (image + its sidecar), and cancel-between-files
 * (already-copied files stay).
 *
 * The filesystem half of these cases is the point of them and is untouched by
 * the cutover. What changed is underneath: `ImportRunner` reaches the database
 * through `imports/repo.ts`, which now re-exports the SQLite repository, and a
 * repository call made from inside a worker tick takes no override — it asks
 * the process for its handle. `createLiveTestDatabase` is what puts one there,
 * for the length of the block that opened it, so every test owns its own
 * database and none of the old "clear the shared collections between cases"
 * bookkeeping (or the "skip when Mongo is unreachable" escape hatch) survives.
 */

import { describe, it, test, expect, beforeAll, afterAll } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ObjectId } from '../db/object-id.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ImportRunner, groupFiles } from './worker.ts';
import type { ImportFileEntry } from '../db/schema.ts';
import { createLiveTestDatabase, insertFolder } from '../db/sqlite/test-sqlite.test-helpers.ts';
import * as repo from './repo.ts';

let tmp: string;
let previousMapleRoots: string | undefined;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-import-worker-'));
  // buildImportFiles' walk() re-checks every path against MAPLE_ROOTS (see
  // scan.ts). Jail to os.tmpdir() for this file's duration so a value left
  // behind by another test file in this shared process can't reject our temp
  // dirs; restored in afterAll so it doesn't leak to files that run after.
  previousMapleRoots = process.env.MAPLE_ROOTS;
  process.env.MAPLE_ROOTS = await fs.realpath(os.tmpdir());
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  if (previousMapleRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = previousMapleRoots;
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

  // M5 — #1635: a video's FULL-NAME sidecar pairs to its movie.
  test('pairs a full-name sidecar to a movie primary (M5)', () => {
    const files: ImportFileEntry[] = [
      mk('2024/06/clip.mov.xmp', 'sidecar'),
      mk('2024/06/clip.mov', 'movie'),
    ];
    const g = groupFiles(files);
    // clip.mov is the only primary.
    expect(g.primaries).toEqual([1]);
    // clip.mov.xmp (idx 0) attaches to clip.mov (idx 1).
    expect(g.sidecars.get(1)).toEqual([0]);
  });

  test('Live Photo: same-stem image + movie each pair to their own sidecar (M5)', () => {
    // clip.jpg + clip.xmp (photo, stem-swap), clip.mov + clip.mov.xmp (movie,
    // full-name). Full-name video sidecars mean distinct keys — no collision.
    const files: ImportFileEntry[] = [
      mk('2024/06/clip.jpg', 'image'),
      mk('2024/06/clip.mov', 'movie'),
      mk('2024/06/clip.xmp', 'sidecar'),
      mk('2024/06/clip.mov.xmp', 'sidecar'),
    ];
    const g = groupFiles(files);
    // Both image and movie are primaries.
    expect(g.primaries.sort((a, b) => a - b)).toEqual([0, 1]);
    // Photo's stem-swap sidecar (idx 2) attaches to the image (idx 0).
    expect(g.sidecars.get(0)).toEqual([2]);
    // Movie's full-name sidecar (idx 3) attaches to the movie (idx 1).
    expect(g.sidecars.get(1)).toEqual([3]);
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

/**
 * Insert the library an import is created against, and return its id.
 *
 * `imports.library_id` is a foreign key onto `folders`, so the bare
 * `new ObjectId()` these tests used to pass is now refused by the insert rather
 * than stored pointing at nothing. `seedLibrary` in
 * `imports-test-db.fixtures.ts` mints one at a fixed `/srv/lib`; these tests
 * copy real bytes into the root they name, so the folder row carries that root
 * instead of a placeholder.
 */
function seedLibraryAt(db: Database, root: string): ObjectId {
  return new ObjectId(insertFolder(db, { path: root }));
}

describe('ImportRunner.tick', () => {
  it('auto import: the worker scans the source and copies (scan_pending)', async () => {
    using live = await createLiveTestDatabase();
    const src = await stageSources('auto', ['IMG.dng', 'IMG.xmp']);
    // Known mtime → deterministic YEAR/MM bucket.
    const when = new Date('2024-03-09T12:00:00Z');
    await fs.utimes(src['IMG.dng'], when, when);
    await fs.utimes(src['IMG.xmp'], when, when);
    const lib = path.join(tmp, 'auto', 'lib');

    const created = await repo.createImport({
      source_root: path.join(tmp, 'auto', 'src'),
      library_id: seedLibraryAt(live.db, lib),
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

    // Worker scanned + filed everything under the default <year>/misc/<source folder>/.
    expect(await fs.readFile(path.join(lib, '2024/misc/src/IMG.dng'), 'utf8')).toBe(
      'bytes-auto-IMG.dng',
    );
    expect(await fs.readFile(path.join(lib, '2024/misc/src/IMG.xmp'), 'utf8')).toBe(
      'bytes-auto-IMG.xmp',
    );
    expect(handed).toBe(1); // the image was handed to the indexer

    const doc = await repo.getImport(created._id);
    expect(doc!.status).toBe('done');
    expect(doc!.scan_pending).toBe(false);
    expect(doc!.progress.total).toBe(2); // image + sidecar
    expect(doc!.counts.copied).toBe(2);
  });

  it('auto import whose source has no importable files is marked failed', async () => {
    using live = await createLiveTestDatabase();
    // A source folder with only a non-media file → nothing to import.
    const dir = path.join(tmp, 'auto-empty', 'src');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'notes.txt'), 'not a photo');
    const lib = path.join(tmp, 'auto-empty', 'lib');

    const created = await repo.createImport({
      source_root: dir,
      library_id: seedLibraryAt(live.db, lib),
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
    using live = await createLiveTestDatabase();
    const src = await stageSources('happy', ['IMG.dng', 'IMG.xmp', 'clip.mov']);
    const lib = path.join(tmp, 'happy', 'lib');
    const libId = seedLibraryAt(live.db, lib);

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
    using live = await createLiveTestDatabase();
    const src = await stageSources('dup', ['IMG.dng', 'IMG.xmp']);
    const lib = path.join(tmp, 'dup', 'lib');

    await repo.createImport({
      source_root: path.join(tmp, 'dup', 'src'),
      library_id: seedLibraryAt(live.db, lib),
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
    using live = await createLiveTestDatabase();
    const src = await stageSources('collide', ['IMG.dng', 'IMG.xmp']);
    const lib = path.join(tmp, 'collide', 'lib');
    // A DIFFERENT photo already occupies the computed image path.
    await fs.mkdir(path.join(lib, '2024/03'), { recursive: true });
    await fs.writeFile(path.join(lib, '2024/03/IMG.dng'), 'a different photo');

    await repo.createImport({
      source_root: path.join(tmp, 'collide', 'src'),
      library_id: seedLibraryAt(live.db, lib),
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
    using live = await createLiveTestDatabase();
    const src = await stageSources('cancel', ['A.dng', 'B.dng']);
    const lib = path.join(tmp, 'cancel', 'lib');

    const created = await repo.createImport({
      source_root: path.join(tmp, 'cancel', 'src'),
      library_id: seedLibraryAt(live.db, lib),
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
    using live = await createLiveTestDatabase();
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
      library_id: seedLibraryAt(live.db, lib),
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
    using live = await createLiveTestDatabase();
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
      library_id: seedLibraryAt(live.db, lib),
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
