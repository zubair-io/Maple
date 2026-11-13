/**
 * ImportRunner when an earlier attempt of the same import stopped partway
 * through a group (#5928): the attempt that takes the import over finishes that
 * group instead of skipping its sidecars. Real temp dirs, real file copies, and
 * a private SQLite database per test.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import type { ImportFileEntry } from '../db/schema.ts';
import { createLiveTestDatabase, insertFolder } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { recordedAttempt } from '../temporal/recorded-attempt.test-helpers.ts';
import * as repo from './repo.ts';
import { ImportRunner, type ImportRunnerDeps } from './worker.ts';

const DIR = '2024/03';
const HASH = { maple_id: 'm', sha1_head: 's', size: 1, mtime: 0 };

let tmp: string;
let previousMapleRoots: string | undefined;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-import-resume-'));
  previousMapleRoots = process.env.MAPLE_ROOTS;
  process.env.MAPLE_ROOTS = await fs.realpath(os.tmpdir());
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  if (previousMapleRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = previousMapleRoots;
});

/** A pending import of `files`, in order, each staged under `<tmp>/<sub>/src`. */
async function pendingImport(
  db: Database,
  sub: string,
  files: [name: string, kind: ImportFileEntry['kind']][],
) {
  const source = path.join(tmp, sub, 'src');
  const lib = path.join(tmp, sub, 'lib');
  await fs.mkdir(source, { recursive: true });
  await Promise.all(
    files.map(([name]) => fs.writeFile(path.join(source, name), `bytes-${sub}-${name}`)),
  );
  const created = await repo.createImport({
    source_root: source,
    library_id: new ObjectId(insertFolder(db, { path: lib })),
    library_root: lib,
    files: files.map(([name, kind]) => ({
      src: path.join(source, name),
      dest: `${DIR}/${name}`,
      size: 1,
      mtime: 0,
      kind,
      state: 'pending' as const,
      error: null,
    })),
  });
  return {
    id: created._id,
    importId: created._id.toHexString(),
    source: (name: string) => path.join(source, name),
    landed: (name: string) => path.join(lib, DIR, name),
    bytes: (name: string) => `bytes-${sub}-${name}`,
  };
}

/** Puts `bytes` at a library path, as a file that is there without this attempt having recorded it. */
async function place(dest: string, bytes: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, bytes);
}

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

/**
 * The clock of an attempt whose worker dies: every database write reads the
 * clock first, so once `writes` have been made the next one never happens and
 * the row is left `running` under that attempt.
 */
function clockOfWorkerKilledAfter(writes: number): () => Date {
  let made = 0;
  return () => {
    if (made >= writes) throw new Error('worker killed');
    made += 1;
    return new Date();
  };
}

/** A runner that records what it hands to the indexer and what it re-arms. */
function observedRunner(config: { now?: () => Date; deps?: Partial<ImportRunnerDeps> } = {}) {
  const handed: string[] = [];
  const rearmed: string[] = [];
  const runner = new ImportRunner({
    now: config.now,
    deps: {
      hashFileForId: async () => HASH,
      assetExistsForHash: async () => false,
      handleEvent: async (event) => {
        handed.push((event as { absPath: string }).absPath);
      },
      rearmSidecarMetadataIndex: async (name) => {
        rearmed.push(name);
      },
      ...config.deps,
    },
  });
  return { runner, handed, rearmed };
}

/** A first attempt whose worker is killed once it has made `writes` database writes. */
async function attemptKilledAfter(writes: number, importId: string) {
  const first = observedRunner({ now: clockOfWorkerKilledAfter(writes) });
  await expect(first.runner.run(importId, recordedAttempt('first'))).rejects.toThrow(
    'worker killed',
  );
  return first;
}

/** The attempt that takes the import over, which must end it `done`. */
async function attemptThatFinishes(
  importId: string,
  config: Parameters<typeof observedRunner>[0] = {},
) {
  const second = observedRunner(config);
  expect(await second.runner.run(importId, recordedAttempt('second'))).toEqual({
    outcome: 'done',
  });
  return second;
}

const IMAGE_WITH_SIDECAR: [string, ImportFileEntry['kind']][] = [
  ['IMG.xmp', 'sidecar'],
  ['IMG.dng', 'image'],
];

const states = async (id: ObjectId) => (await repo.getImportFiles(id)).map((file) => file.state);

test('an attempt killed between copying an image and recording it leaves the sidecar to the next attempt', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'killed', IMAGE_WITH_SIDECAR);
  const first = await attemptKilledAfter(1, imp.importId);

  expect(await fs.readFile(imp.landed('IMG.dng'), 'utf8')).toBe(imp.bytes('IMG.dng'));
  expect(await exists(imp.landed('IMG.xmp'))).toBe(false);
  expect(await states(imp.id)).toEqual(['pending', 'pending']);
  expect((await repo.getImport(imp.id))!.status).toBe('running');
  expect(first.handed).toEqual([]);

  const second = await attemptThatFinishes(imp.importId);

  expect(await fs.readFile(imp.landed('IMG.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  const after = (await repo.getImport(imp.id))!;
  expect(after.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(after.progress).toEqual({ current: 2, total: 2 });
  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
  expect(second.rearmed).toEqual(['IMG.dng']);
});

test('the sidecar still follows when the sweep catalogued the unrecorded image before the next attempt', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'catalogued', IMAGE_WITH_SIDECAR);
  await attemptKilledAfter(1, imp.importId);

  const second = await attemptThatFinishes(imp.importId, {
    deps: { assetExistsForHash: async () => true },
  });

  expect(await fs.readFile(imp.landed('IMG.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
  expect(second.rearmed).toEqual(['IMG.dng']);
});

test('an attempt replaced after copying an image has its record refused, and the replacement copies the sidecar', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'replaced', IMAGE_WITH_SIDECAR);
  const first = observedRunner({
    deps: {
      hashFileForId: async () => {
        await repo.claimImport(imp.id, 'second');
        return HASH;
      },
    },
  });

  await expect(first.runner.run(imp.importId, recordedAttempt('first'))).rejects.toBeInstanceOf(
    repo.ImportTakenOver,
  );
  expect(await exists(imp.landed('IMG.dng'))).toBe(true);
  expect(await states(imp.id)).toEqual(['pending', 'pending']);

  const second = await attemptThatFinishes(imp.importId);

  expect(await fs.readFile(imp.landed('IMG.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
});

test('the replacement finishes the group when the attempt it replaced lands the image mid-copy', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'raced', IMAGE_WITH_SIDECAR);
  await repo.claimImport(imp.id, 'first');
  const second = await attemptThatFinishes(imp.importId, {
    deps: {
      hashFileForId: async () => {
        await place(imp.landed('IMG.dng'), imp.bytes('IMG.dng'));
        return HASH;
      },
    },
  });

  expect(await fs.readFile(imp.landed('IMG.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
});

test('an attempt killed while copying sidecars still gets its image indexed and re-armed by the next attempt', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'sidecar-stage', [
    ['IMG.xmp', 'sidecar'],
    ['IMG (conflict from Mac).xmp', 'sidecar'],
    ['IMG.dng', 'image'],
  ]);
  const first = await attemptKilledAfter(2, imp.importId);

  expect(await exists(imp.landed('IMG.xmp'))).toBe(true);
  expect(await exists(imp.landed('IMG (conflict from Mac).xmp'))).toBe(false);
  expect(await states(imp.id)).toEqual(['pending', 'pending', 'copied']);
  expect(first.handed).toEqual([]);

  const second = await attemptThatFinishes(imp.importId);

  expect(await fs.readFile(imp.landed('IMG (conflict from Mac).xmp'), 'utf8')).toBe(
    imp.bytes('IMG (conflict from Mac).xmp'),
  );
  expect(await states(imp.id)).toEqual(['copied', 'copied', 'copied']);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 3, skipped: 0, failed: 0 });
  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
  expect(second.rearmed).toEqual(['IMG.dng']);
});

test('the next attempt indexes the image even when every sidecar had landed before the kill', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'sidecar-landed', IMAGE_WITH_SIDECAR);
  await attemptKilledAfter(2, imp.importId);
  expect(await exists(imp.landed('IMG.xmp'))).toBe(true);
  expect(await states(imp.id)).toEqual(['pending', 'copied']);

  const second = await attemptThatFinishes(imp.importId);

  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
  expect(second.rearmed).toEqual(['IMG.dng']);
});

test('a duplicate in a group the earlier attempt never reached is still skipped with its sidecar', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'later-duplicate', [
    ['IMG.xmp', 'sidecar'],
    ['IMG.dng', 'image'],
    ['clip.mov', 'movie'],
    ['clip.mov.xmp', 'sidecar'],
  ]);
  await place(imp.landed('clip.mov'), imp.bytes('clip.mov'));
  await attemptKilledAfter(1, imp.importId);

  await attemptThatFinishes(imp.importId);

  expect(await states(imp.id)).toEqual([
    'copied',
    'copied',
    'skipped_duplicate',
    'skipped_duplicate',
  ]);
  expect(await exists(imp.landed('clip.mov.xmp'))).toBe(false);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 2, failed: 0 });
});

test('a movie the earlier attempt copied but never recorded gets its sidecar, and is not handed to the indexer', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'movie', [
    ['clip.mov', 'movie'],
    ['clip.mov.xmp', 'sidecar'],
  ]);
  await attemptKilledAfter(1, imp.importId);
  expect(await exists(imp.landed('clip.mov'))).toBe(true);
  expect(await exists(imp.landed('clip.mov.xmp'))).toBe(false);

  const second = await attemptThatFinishes(imp.importId);

  expect(await fs.readFile(imp.landed('clip.mov.xmp'), 'utf8')).toBe(imp.bytes('clip.mov.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied']);
  expect((await repo.getImport(imp.id))!.counts).toEqual({ copied: 2, skipped: 0, failed: 0 });
  expect(second.handed).toEqual([]);
});

test('groups finished before the kill keep their outcome and are not handed over again', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'second-group', [
    ['A.dng', 'image'],
    ['B.xmp', 'sidecar'],
    ['B.dng', 'image'],
  ]);
  const first = await attemptKilledAfter(2, imp.importId);
  expect(await states(imp.id)).toEqual(['copied', 'pending', 'pending']);
  expect(await exists(imp.landed('B.dng'))).toBe(true);
  expect(first.handed).toEqual([imp.landed('A.dng')]);

  const second = await attemptThatFinishes(imp.importId);

  expect(await fs.readFile(imp.landed('B.xmp'), 'utf8')).toBe(imp.bytes('B.xmp'));
  expect(await states(imp.id)).toEqual(['copied', 'copied', 'copied']);
  const after = (await repo.getImport(imp.id))!;
  expect(after.counts).toEqual({ copied: 3, skipped: 0, failed: 0 });
  expect(after.progress).toEqual({ current: 3, total: 3 });
  expect(second.handed).toEqual([imp.landed('B.dng')]);
});

test('an Auto Import taken over before its scan finished has copied nothing, so a file already there is a duplicate', async () => {
  using live = await createLiveTestDatabase();
  const source = path.join(tmp, 'unscanned', 'src');
  const lib = path.join(tmp, 'unscanned', 'lib');
  const captured = new Date('2024-03-09T12:00:00Z');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'IMG.dng'), 'unscanned image');
  await fs.writeFile(path.join(source, 'IMG.xmp'), 'unscanned sidecar');
  await fs.utimes(path.join(source, 'IMG.dng'), captured, captured);
  await fs.utimes(path.join(source, 'IMG.xmp'), captured, captured);
  await place(path.join(lib, '2024/misc/src/IMG.dng'), 'unscanned image');
  const created = await repo.createImport({
    source_root: source,
    library_id: new ObjectId(insertFolder(live.db, { path: lib })),
    library_root: lib,
    files: [],
    scan_pending: true,
  });
  await repo.claimImport(created._id, 'first');

  const second = await attemptThatFinishes(created._id.toHexString());

  expect((await repo.getImportFiles(created._id)).map((file) => file.state).sort()).toEqual([
    'skipped_duplicate',
    'skipped_duplicate',
  ]);
  expect(await exists(path.join(lib, '2024/misc/src/IMG.xmp'))).toBe(false);
  expect(second.handed).toEqual([]);
});

test('a different sidecar already beside the unrecorded image is left alone, with no renamed copy', async () => {
  using live = await createLiveTestDatabase();
  const imp = await pendingImport(live.db, 'edited-since', IMAGE_WITH_SIDECAR);
  await repo.claimImport(imp.id, 'first');
  await place(imp.landed('IMG.dng'), imp.bytes('IMG.dng'));
  await place(imp.landed('IMG.xmp'), 'edits made in the library');

  const second = await attemptThatFinishes(imp.importId);

  expect(await fs.readFile(imp.landed('IMG.xmp'), 'utf8')).toBe('edits made in the library');
  expect((await fs.readdir(path.dirname(imp.landed('IMG.dng')))).sort()).toEqual([
    'IMG.dng',
    'IMG.xmp',
  ]);
  expect(await states(imp.id)).toEqual(['skipped_duplicate', 'copied']);
  expect(await fs.readFile(imp.source('IMG.xmp'), 'utf8')).toBe(imp.bytes('IMG.xmp'));
  expect(second.handed).toEqual([imp.landed('IMG.dng')]);
});
