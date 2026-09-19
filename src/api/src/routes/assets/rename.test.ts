/**
 * Integration tests for POST /api/assets/:id/rename (#2636).
 *
 * Mirrors `relocate.test.ts`: wiring/validation cases never reach storage, then
 * a real SQLite database (#3787) installed as the process-wide handle plus real
 * temp-dir files for the end-to-end cases.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { Elysia } from 'elysia';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { renameRoutes } from './rename.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import { setRawFfiForTests, tryGetRawFfi } from '../../ffi/raw_ffi.ts';
import { fakeAuth } from '../../../tests/helpers/test-auth.ts';
import { newObjectIdHex } from '../../db/sqlite/object-id.ts';
import { locationRows } from '../../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

// Any test whose expected outcome depends on `validateNewFilename` actually
// consulting the native engine (a real accept/reject, or reaching
// `relocateAsset` at all) needs `tryGetRawFfi()` to be non-null — absent in
// this repo's CI (`.github/workflows/api.yml` never builds `libraw_ffi`;
// see `library/batch-rename.test.ts`'s module doc for the full rationale).
// The "fails closed" describe block below is exempt: it forces the engine
// to `null` itself via `setRawFfiForTests`, so it's deterministic either
// way and stays on plain `test`.
const ffiAvailable = tryGetRawFfi() !== null;
const maybeTest = ffiAvailable ? test : test.skip;

const app = new Elysia({ prefix: '/api/assets' }).use(fakeAuth()).use(renameRoutes);

async function postRename(id: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api/assets/${id}/rename`, {
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-route-'));
});

afterEach(async () => {
  live.close();
  await fs.rm(root, { recursive: true, force: true });
  setLibraryRootsForTests(null);
});

// ---------------------------------------------------------------------------
// Wiring / validation.
// ---------------------------------------------------------------------------

describe('POST /api/assets/:id/rename — wiring', () => {
  test('returns 400 for a malformed asset id', async () => {
    const res = await postRename('not-an-object-id', {
      new_filename: 'IMG_0002.dng',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(400);
  });

  test('returns 4xx for an invalid collision policy', async () => {
    const res = await postRename(newObjectIdHex(), {
      new_filename: 'IMG_0002.dng',
      collision: 'yolo',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('rejects a new_filename carrying a path separator', async () => {
    const res = await postRename(newObjectIdHex(), {
      new_filename: 'sub/IMG_0002.dng',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(400);
  });

  maybeTest('rejects a Windows-reserved-device-name new_filename', async () => {
    const res = await postRename(newObjectIdHex(), {
      new_filename: 'CON.dng',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(400);
  });

  maybeTest('rejects a new_filename with a trailing dot', async () => {
    const res = await postRename(newObjectIdHex(), {
      new_filename: 'IMG_0002.',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed when the native validation engine is unavailable — it must
// reject before ever reaching the catalogue or the filesystem.
// ---------------------------------------------------------------------------

describe('POST /api/assets/:id/rename — fails closed when the engine is unavailable', () => {
  afterEach(() => {
    setRawFfiForTests(undefined); // restore real load/cache behaviour
  });

  test('returns 503, not a silently-passed rename, when tryGetRawFfi() is null', async () => {
    setRawFfiForTests(null);
    const res = await postRename(newObjectIdHex(), {
      // Would PASS isSafeFilename (single segment, no leading dot) — proves
      // this is rejected by the fail-closed engine-unavailable branch, not
      // by the fast isSafeFilename check that runs regardless.
      new_filename: 'CON.dng',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/engine unavailable/i);
  });

  test('an isSafeFilename violation still 400s even with the engine unavailable', async () => {
    setRawFfiForTests(null);
    const res = await postRename(newObjectIdHex(), {
      new_filename: 'sub/IMG_0002.dng',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// End-to-end — real catalogue + real temp-dir files.
// ---------------------------------------------------------------------------

/** Register one library root under `root` and wire the roots cache to it. */
function seedLibrary(db: Database): string {
  const libraryId = insertFolder(db, { path: root, slug: 'rename-route-test' });
  setLibraryRootsForTests(new Map([[libraryId, root]]));
  return libraryId;
}

/** One asset at `a/<filename>` under `root`, in `libraryId`. */
async function seedOnDisk(
  db: Database,
  libraryId: string,
  filename: string,
  content = 'pixels',
): Promise<string> {
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  await fs.writeFile(path.join(root, 'a', filename), content);
  const id = insertAsset(db);
  insertLocation(db, { assetId: id, libraryId, path: 'a', filename });
  run(db, `UPDATE assets SET size = ?, mtime = 1700000000000 WHERE id = ?`, content.length, id);
  return id;
}

/** Write `a/IMG_1.dng` under `root` and seed a matching asset. */
async function seedAssetOnDisk(db: Database, filename = 'IMG_1.dng'): Promise<string> {
  return seedOnDisk(db, seedLibrary(db), filename);
}

describe('POST /api/assets/:id/rename — replace collision guard (#2843)', () => {
  maybeTest(
    'renaming onto a filename occupied by another live indexed asset is refused with 409',
    async () => {
      const libraryId = seedLibrary(live.db);
      const incomingId = await seedOnDisk(live.db, libraryId, 'incoming.dng', 'incoming-pixels');
      const occupantId = await seedOnDisk(live.db, libraryId, 'occupant.dng', 'occupant-pixels');

      const res = await postRename(incomingId, {
        new_filename: 'occupant.dng',
        collision: 'replace',
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.occupied_by_asset_id).toBe(occupantId);
      expect(await fs.readFile(path.join(root, 'a', 'incoming.dng'), 'utf8')).toBe(
        'incoming-pixels',
      );
      expect(await fs.readFile(path.join(root, 'a', 'occupant.dng'), 'utf8')).toBe(
        'occupant-pixels',
      );
    },
  );

  maybeTest(
    'renaming onto a filename occupied only by an untracked file still succeeds (200)',
    async () => {
      const id = await seedAssetOnDisk(live.db);
      await fs.writeFile(path.join(root, 'a', 'untracked.dng'), 'stale-untracked-bytes');

      const res = await postRename(id, {
        new_filename: 'untracked.dng',
        collision: 'replace',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.new_filename).toBe('untracked.dng');
    },
  );
});

describe('POST /api/assets/:id/rename — end to end', () => {
  maybeTest('renames the asset in place (same folder), returns the new address', async () => {
    const id = await seedAssetOnDisk(live.db);

    const res = await postRename(id, {
      new_filename: 'IMG_renamed.dng',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.new_path).toBe('a');
    expect(body.new_filename).toBe('IMG_renamed.dng');
    expect(body.renamed_on_collision).toBe(false);
    expect(body.extension_changed).toBe(false);

    const location = locationRows(live.db, id)[0]!;
    expect(location.path).toBe('a');
    expect(location.filename).toBe('IMG_renamed.dng');
    await expect(fs.readFile(path.join(root, 'a', 'IMG_1.dng'), 'utf8')).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'a', 'IMG_renamed.dng'), 'utf8')).toBe('pixels');
  });

  maybeTest('flags an extension change in the response, but still allows it', async () => {
    const id = await seedAssetOnDisk(live.db);

    const res = await postRename(id, {
      new_filename: 'IMG_renamed.jpg',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.new_filename).toBe('IMG_renamed.jpg');
    expect(body.extension_changed).toBe(true);
  });

  maybeTest('a collision with an existing file at the destination auto-suffixes', async () => {
    const id = await seedAssetOnDisk(live.db);
    await fs.writeFile(path.join(root, 'a', 'existing.dng'), 'other pixels');

    const res = await postRename(id, {
      new_filename: 'existing.dng',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.renamed_on_collision).toBe(true);
    expect(body.new_filename).not.toBe('existing.dng');
  });

  maybeTest('returns 404 for an unknown asset id', async () => {
    const res = await postRename(newObjectIdHex(), {
      new_filename: 'IMG_renamed.dng',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(404);
  });
});
