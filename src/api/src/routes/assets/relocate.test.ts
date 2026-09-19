/**
 * Integration tests for POST /api/assets/:id/relocate (#2629).
 *
 * Validation and path-traversal cases never reach storage; the end-to-end ones
 * run against a real SQLite database (#3787) installed as the process-wide
 * handle, plus real temp-dir files. Nothing external, so nothing to skip on.
 *
 * Where a location lives changed with the port: `asset_locations` is a table
 * with a unique index over (library_id, path, filename), so the occupied-
 * destination fixture seeds its two assets at two distinct addresses — a
 * library that held two live rows at one address is a state the schema now
 * rules out.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { Elysia } from 'elysia';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { relocateRoutes } from './relocate.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import { fakeAuth } from '../../../tests/helpers/test-auth.ts';
import { newObjectIdHex } from '../../db/object-id.ts';
import { locationRows } from '../../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

const app = new Elysia({ prefix: '/api/assets' }).use(fakeAuth()).use(relocateRoutes);

async function postRelocate(id: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api/assets/${id}/relocate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

let live: LiveTestDatabase;
let root: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-route-'));
});

afterEach(async () => {
  live.close();
  await fs.rm(root, { recursive: true, force: true });
  setLibraryRootsForTests(null);
});

// ---------------------------------------------------------------------------
// Wiring / validation.
// ---------------------------------------------------------------------------

describe('POST /api/assets/:id/relocate — wiring', () => {
  test('returns 400 for a malformed asset id', async () => {
    const res = await postRelocate('not-an-object-id', {
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: 'b',
    });
    expect(res.status).toBe(400);
  });

  test('returns 4xx for an invalid mode', async () => {
    const res = await postRelocate(newObjectIdHex(), {
      mode: 'teleport',
      collision: 'auto-suffix',
      destination_path: 'b',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('returns 4xx for an invalid collision policy', async () => {
    const res = await postRelocate(newObjectIdHex(), {
      mode: 'move',
      collision: 'yolo',
      destination_path: 'b',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('returns 4xx when destination_path is missing', async () => {
    const res = await postRelocate(newObjectIdHex(), {
      mode: 'move',
      collision: 'auto-suffix',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Path traversal — rejected at the HTTP boundary, before the catalogue or the
// filesystem are ever touched (jules review on #2669).
// ---------------------------------------------------------------------------

describe('POST /api/assets/:id/relocate — path traversal is rejected with 400', () => {
  test('destination_path with ../.. traversal', async () => {
    const res = await postRelocate(newObjectIdHex(), {
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: '../../etc/passwd',
    });
    expect(res.status).toBe(400);
  });

  test('an absolute destination_path', async () => {
    const res = await postRelocate(newObjectIdHex(), {
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: '/etc/passwd',
    });
    expect(res.status).toBe(400);
  });

  test('a backslash-variant destination_path', async () => {
    const res = await postRelocate(newObjectIdHex(), {
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: 'a\\..\\..\\etc\\passwd',
    });
    expect(res.status).toBe(400);
  });

  test('a destination_filename carrying its own traversal', async () => {
    const res = await postRelocate(newObjectIdHex(), {
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: 'b',
      destination_filename: '../../../etc/passwd',
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// End-to-end — real catalogue + real temp-dir files.
// ---------------------------------------------------------------------------

/** One asset at `relPath`/`filename` under `root`, in `libraryId`. */
async function seedOnDisk(
  db: Database,
  libraryId: string,
  entry: { relPath: string; filename: string; content: string },
): Promise<string> {
  await fs.mkdir(path.join(root, entry.relPath), { recursive: true });
  await fs.writeFile(path.join(root, entry.relPath, entry.filename), entry.content);
  const id = insertAsset(db);
  insertLocation(db, {
    assetId: id,
    libraryId,
    path: entry.relPath,
    filename: entry.filename,
  });
  run(
    db,
    `UPDATE assets SET size = ?, mtime = 1700000000000 WHERE id = ?`,
    entry.content.length,
    id,
  );
  return id;
}

/** Register one library root under `root` and wire the roots cache to it. */
function seedLibrary(db: Database): string {
  const libraryId = insertFolder(db, { path: root, slug: 'relocate-route-test' });
  setLibraryRootsForTests(new Map([[libraryId, root]]));
  return libraryId;
}

/** Write `a/IMG_1.dng` under `root` and seed a matching asset. */
async function seedAssetOnDisk(db: Database): Promise<string> {
  const libraryId = seedLibrary(db);
  return seedOnDisk(db, libraryId, { relPath: 'a', filename: 'IMG_1.dng', content: 'pixels' });
}

describe('POST /api/assets/:id/relocate — replace collision guard (#2843)', () => {
  test('replace onto a path occupied by another live indexed asset is refused with 409', async () => {
    const libraryId = seedLibrary(live.db);
    const incomingId = await seedOnDisk(live.db, libraryId, {
      relPath: 'a',
      filename: 'incoming.dng',
      content: 'incoming-pixels',
    });
    const occupantId = await seedOnDisk(live.db, libraryId, {
      relPath: 'b',
      filename: 'occupant.dng',
      content: 'occupant-pixels',
    });

    const res = await postRelocate(incomingId, {
      mode: 'move',
      collision: 'replace',
      destination_path: 'b',
      destination_filename: 'occupant.dng',
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.occupied_by_asset_id).toBe(occupantId);

    // Neither file moved.
    expect(await fs.readFile(path.join(root, 'a', 'incoming.dng'), 'utf8')).toBe('incoming-pixels');
    expect(await fs.readFile(path.join(root, 'b', 'occupant.dng'), 'utf8')).toBe('occupant-pixels');
    // Neither row moved.
    expect(locationRows(live.db, incomingId)[0]!.path).toBe('a');
    expect(locationRows(live.db, occupantId)[0]!.path).toBe('b');
  });

  test('replace onto a path occupied only by an untracked file still succeeds (200)', async () => {
    const id = await seedAssetOnDisk(live.db);
    await fs.writeFile(path.join(root, 'a', 'untracked.dng'), 'stale-untracked-bytes');

    const res = await postRelocate(id, {
      mode: 'move',
      collision: 'replace',
      destination_path: 'a',
      destination_filename: 'untracked.dng',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.new_filename).toBe('untracked.dng');
  });
});

describe('POST /api/assets/:id/relocate — end to end', () => {
  test('moves the asset, returns the new path, and repoints the catalogue', async () => {
    const id = await seedAssetOnDisk(live.db);

    const res = await postRelocate(id, {
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: 'b',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.new_path).toBe('b');
    expect(body.new_filename).toBe('IMG_1.dng');
    expect(body.renamed_on_collision).toBe(false);

    expect(locationRows(live.db, id)[0]!.path).toBe('b');
    await expect(fs.readFile(path.join(root, 'a', 'IMG_1.dng'), 'utf8')).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'b', 'IMG_1.dng'), 'utf8')).toBe('pixels');
  });

  test('returns 404 for an unknown asset id', async () => {
    const res = await postRelocate(newObjectIdHex(), {
      mode: 'move',
      collision: 'auto-suffix',
      destination_path: 'b',
    });
    expect(res.status).toBe(404);
  });
});
