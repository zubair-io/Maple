/**
 * The folder-scan handler against a real directory: it walks every supported
 * file into the discover producer, skips the reserved trees, stamps
 * `last_scan` when it completes, and stops between directory batches when
 * cancelled. Relinking and `.mapleignore` are covered through the scan routes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectId } from '../../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { folderScanHandler } from './folder-scan.ts';
import type { JobHandlerContext } from './index.ts';

let live: LiveTestDatabase;
let root: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'folder-scan-'));
  invalidateLibraryRoots();
});

afterEach(async () => {
  live.close();
  invalidateLibraryRoots();
  await rm(root, { recursive: true, force: true });
});

function context(cancelled = false) {
  const progress: number[] = [];
  const ctx: JobHandlerContext = {
    jobId: new ObjectId(),
    reportProgress: async (current) => {
      progress.push(current);
    },
    shouldCancel: async () => cancelled,
  };
  return { ctx, progress };
}

const indexedPaths = () =>
  (
    live.db.query(`SELECT path, filename FROM asset_locations ORDER BY path`).all() as {
      path: string;
      filename: string;
    }[]
  ).map((row) => join(row.path, row.filename));

const lastScan = (folderId: string) =>
  (
    live.db.query(`SELECT last_scan FROM folders WHERE id = ?`).get(folderId) as {
      last_scan: string | null;
    }
  ).last_scan;

describe('folder_scan', () => {
  it('indexes supported files, skips the reserved trees, and stamps last_scan', async () => {
    await mkdir(join(root, 'trip', 'day1'), { recursive: true });
    await mkdir(join(root, '.maple'), { recursive: true });
    await mkdir(join(root, '_duplicates'), { recursive: true });
    await writeFile(join(root, 'trip', 'day1', 'a.jpg'), 'a bytes');
    await writeFile(join(root, 'trip', 'b.dng'), 'b bytes');
    await writeFile(join(root, 'trip', 'notes.txt'), 'not media');
    await writeFile(join(root, '.maple', 'c.jpg'), 'cache');
    await writeFile(join(root, '_duplicates', 'd.jpg'), 'copy');
    const folderId = insertFolder(live.db, { path: root, slug: 'scan' });
    const { ctx, progress } = context();

    const outcome = await folderScanHandler.run({ folderId }, ctx);

    expect(outcome.kind).toBe('done');
    expect(indexedPaths()).toEqual(['trip/b.dng', 'trip/day1/a.jpg']);
    expect(lastScan(folderId)).toBe(outcome.result['last_scan'] as string);
    expect(progress.at(-1)).toBe(2);
  });

  it('stops when cancelled and leaves last_scan alone', async () => {
    await writeFile(join(root, 'a.jpg'), 'a bytes');
    const folderId = insertFolder(live.db, { path: root, slug: 'cancelled' });

    const outcome = await folderScanHandler.run({ folderId }, context(true).ctx);

    expect(outcome).toEqual({ kind: 'cancelled', result: { last_scan: null } });
    expect(indexedPaths()).toEqual([]);
    expect(lastScan(folderId)).toBeNull();
  });

  it('fails for a folder that is no longer registered', async () => {
    const run = folderScanHandler.run({ folderId: new ObjectId().toHexString() }, context().ctx);

    await expect(run).rejects.toThrow('Folder not found');
  });
});
