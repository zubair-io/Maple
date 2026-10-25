/**
 * `.mapleignore` (#5398) on the folder routes that write into a library or
 * walk it outside the sweep: an upload into an ignored folder stores the
 * bytes but catalogues nothing, and a rescan's re-walk never indexes an
 * ignored subtree.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { foldersRoutes } from './folders.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { toObjectId } from '../db/repos/values.ts';
import { hashFileForId } from '../indexer/id.ts';
import { handleEvent } from '../workers/discover/handle-event.ts';
import * as frontier from '../workers/discover/frontier.repo.ts';
import { SweeperLoop } from '../workers/discover/sweeper.ts';
import { runMissingReaperOnce } from '../workers/missing-reaper.ts';

describe('folder routes under a .mapleignore folder', () => {
  let live: LiveTestDatabase;
  let root: string;
  let folderId: string;
  const app = new Elysia().use(fakeAuth()).use(foldersRoutes);

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    root = await mkdtemp(nodePath.join(tmpdir(), 'maple-ignore-routes-'));
    folderId = insertFolder(live.db, { path: root, slug: 'ignore-test' });
    invalidateLibraryRoots();
    await mkdir(nodePath.join(root, 'skip'), { recursive: true });
    await writeFile(nodePath.join(root, 'skip', '.mapleignore'), '');
  });

  afterEach(async () => {
    live.close();
    invalidateLibraryRoots();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  function count(sql: string): number {
    return (live.db.query(sql).get() as { n: number }).n;
  }

  function upload(target: string, bytes: Uint8Array<ArrayBuffer>): Promise<Response> {
    return app.handle(
      new Request(`http://localhost/api/folders/${folderId}/upload`, {
        method: 'POST',
        headers: { 'X-Maple-Target-Path': target, 'Content-Type': 'application/octet-stream' },
        body: bytes,
      }),
    );
  }

  it('stores an upload into an ignored (nested) folder without cataloguing it', async () => {
    const bytes = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x01]);
    const res = await upload('skip/new/sub/photo.dng', bytes);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { abs_path: string; asset_id?: string };
    expect(body.asset_id).toBeUndefined();
    expect(new Uint8Array(await readFile(body.abs_path))).toEqual(bytes);
    expect(count(`SELECT COUNT(*) AS n FROM assets`)).toBe(0);

    // File Provider clients still see the stored file through the change feed.
    const change = live.db
      .query(`SELECT kind, asset_id, relative_path FROM asset_changes`)
      .get() as { kind: string; asset_id: string | null; relative_path: string };
    expect(change).toEqual({
      kind: 'create',
      asset_id: null,
      relative_path: 'skip/new/sub/photo.dng',
    });

    // Outside the ignored folder the same upload is catalogued as usual.
    const indexed = await upload('keep/photo.dng', bytes);
    expect(((await indexed.json()) as { asset_id?: string }).asset_id).toMatch(/^[a-f0-9]{24}$/);
  });

  async function sweepGeneration(gen: number): Promise<void> {
    invalidateLibraryRoots();
    const library = toObjectId(folderId);
    await frontier.seedRoot(library, root, gen);
    const loop = new SweeperLoop({
      folderId: library,
      root,
      startGen: gen,
      deps: { folderId: library, handleEvent },
      loadConfig: async () => ({ paused: false, sweepDirIntervalMs: 0 }),
      sleep: async () => {},
    });
    await loop.runUntilIdleOrPaused();
  }

  function assetAt(dir: string, filename: string): string | null {
    const row = live.db
      .query(`SELECT asset_id FROM asset_locations WHERE path = ? AND filename = ?`)
      .get(dir, filename) as { asset_id: string } | null;
    return row?.asset_id ?? null;
  }

  it('an upload over an excluded original retires its claim, so unignoring ingests a new asset', async () => {
    const marker = nodePath.join(root, 'skip', '.mapleignore');
    await rm(marker);
    const original = nodePath.join(root, 'skip', 'photo.jpg');
    await writeFile(original, 'old photo bytes');
    await sweepGeneration(1);
    const oldId = assetAt('skip', 'photo.jpg')!;
    expect(oldId).not.toBeNull();

    await writeFile(marker, '');
    await sweepGeneration(2);
    const res = await upload('skip/photo.jpg', new TextEncoder().encode('new photo bytes'));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { asset_id?: string }).asset_id).toBeUndefined();
    const trashed = nodePath.join(root, '.maple', 'trash', 'skip', 'photo.jpg');
    expect(await readFile(trashed, 'utf8')).toBe('old photo bytes');

    await rm(marker);
    await sweepGeneration(3);
    await runMissingReaperOnce({ deleteBeforeIso: '2000-01-01T00:00:00.000Z' });

    const newId = assetAt('skip', 'photo.jpg');
    expect(newId).not.toBeNull();
    expect(newId).not.toBe(oldId);
    const { sha1_head } = await hashFileForId(original);
    const row = live.db.query(`SELECT sha1_head FROM assets WHERE id = ?`).get(newId!) as {
      sha1_head: string;
    };
    expect(row.sha1_head).toBe(sha1_head);
    const oldPaths = live.db
      .query(`SELECT path FROM asset_locations WHERE asset_id = ?`)
      .all(oldId) as Array<{ path: string }>;
    expect(oldPaths.map((l) => l.path)).toEqual(['.maple/trash/skip']);
    expect(await readFile(trashed, 'utf8')).toBe('old photo bytes');
  });

  it('never indexes an ignored subtree during a rescan re-walk', async () => {
    await mkdir(nodePath.join(root, 'skip', 'nested'), { recursive: true });
    await writeFile(nodePath.join(root, 'skip', 'nested', 'b.jpg'), 'ignored bytes');
    await mkdir(nodePath.join(root, 'keep'), { recursive: true });
    await writeFile(nodePath.join(root, 'keep', 'a.jpg'), 'kept bytes');

    const res = await app.handle(
      new Request(`http://localhost/api/folders/${folderId}/rescan`, { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    const paths = live.db.query(`SELECT path FROM asset_locations ORDER BY path`).all() as Array<{
      path: string;
    }>;
    expect(paths.map((p) => p.path)).toEqual(['keep']);
  });
});
