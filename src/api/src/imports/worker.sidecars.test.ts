/**
 * ImportRunner outcomes for a primary that has several sidecars. Real temp
 * dirs, real file copies, and a private SQLite database per test.
 */

import { it, expect, beforeAll, afterAll } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ObjectId } from '../db/object-id.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ImportRunner } from './worker.ts';
import { recordedAttempt } from '../temporal/recorded-attempt.test-helpers.ts';
import type { ImportFileEntry } from '../db/schema.ts';
import { createLiveTestDatabase, insertFolder } from '../db/sqlite/test-sqlite.test-helpers.ts';
import * as repo from './repo.ts';
import { retryImport } from './retry.ts';

let tmp: string;
let previousMapleRoots: string | undefined;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-import-sidecars-'));
  previousMapleRoots = process.env.MAPLE_ROOTS;
  process.env.MAPLE_ROOTS = await fs.realpath(os.tmpdir());
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  if (previousMapleRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = previousMapleRoots;
});

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

function seedLibraryAt(db: Database, root: string): ObjectId {
  return new ObjectId(insertFolder(db, { path: root }));
}

function entry(src: string, dest: string, kind: ImportFileEntry['kind']): ImportFileEntry {
  return { src, dest, size: 1, mtime: 0, kind, state: 'pending', error: null };
}

it('gives every sidecar the primary outcome when the primary fails, and a retry copies them all', async () => {
  using live = await createLiveTestDatabase();
  const names = ['IMG.dng', 'IMG.xmp', 'IMG (conflict from Mac).xmp'];
  const src = await stageSources('multi-fail', names);
  const lib = path.join(tmp, 'multi-fail', 'lib');
  const stashed = `${src['IMG.dng']}.stashed`;
  await fs.rename(src['IMG.dng'], stashed);

  const created = await repo.createImport({
    source_root: path.join(tmp, 'multi-fail', 'src'),
    library_id: seedLibraryAt(live.db, lib),
    library_root: lib,
    files: [
      entry(src['IMG.xmp'], '2024/03/IMG.xmp', 'sidecar'),
      entry(src['IMG (conflict from Mac).xmp'], '2024/03/IMG (conflict from Mac).xmp', 'sidecar'),
      entry(src['IMG.dng'], '2024/03/IMG.dng', 'image'),
    ],
  });
  const runner = new ImportRunner({
    deps: {
      hashFileForId: (async () => ({ maple_id: 'm', sha1_head: 's' })) as never,
      assetExistsForHash: async () => false,
      handleEvent: async () => {},
      rearmSidecarMetadataIndex: async () => {},
    },
  });
  expect(
    (await runner.run(created._id.toHexString(), recordedAttempt('w-multi-fail'))).outcome,
  ).toBe('failed');

  const failedFiles = await repo.getImportFiles(created._id);
  expect(failedFiles.map((f) => f.state)).toEqual(['failed', 'failed', 'failed']);

  await fs.rename(stashed, src['IMG.dng']);
  expect(await retryImport(created._id)).toBe(true);
  expect(
    (await runner.run(created._id.toHexString(), recordedAttempt('w-multi-fail'))).outcome,
  ).toBe('done');
  const retried = await repo.getImportFiles(created._id);
  expect(retried.map((f) => f.state)).toEqual(['copied', 'copied', 'copied']);
});

it('skips every sidecar when the primary is already on disk byte-identical', async () => {
  using live = await createLiveTestDatabase();
  const names = ['IMG.dng', 'IMG.xmp', 'IMG (conflict from Mac).xmp'];
  const src = await stageSources('multi-skip', names);
  const lib = path.join(tmp, 'multi-skip', 'lib');
  await fs.mkdir(path.join(lib, '2024/03'), { recursive: true });
  await fs.copyFile(src['IMG.dng'], path.join(lib, '2024/03/IMG.dng'));

  const created = await repo.createImport({
    source_root: path.join(tmp, 'multi-skip', 'src'),
    library_id: seedLibraryAt(live.db, lib),
    library_root: lib,
    files: [
      entry(src['IMG.xmp'], '2024/03/IMG.xmp', 'sidecar'),
      entry(src['IMG (conflict from Mac).xmp'], '2024/03/IMG (conflict from Mac).xmp', 'sidecar'),
      entry(src['IMG.dng'], '2024/03/IMG.dng', 'image'),
    ],
  });
  const runner = new ImportRunner({
    deps: {
      assetExistsForHash: async () => false,
      handleEvent: async () => {},
      rearmSidecarMetadataIndex: async () => {},
    },
  });
  expect(
    (await runner.run(created._id.toHexString(), recordedAttempt('w-multi-skip'))).outcome,
  ).toBe('done');

  const files = await repo.getImportFiles(created._id);
  expect(files.map((f) => f.state)).toEqual([
    'skipped_duplicate',
    'skipped_duplicate',
    'skipped_duplicate',
  ]);
  expect((await repo.getImport(created._id))!.counts).toEqual({
    copied: 0,
    skipped: 3,
    failed: 0,
  });
});
