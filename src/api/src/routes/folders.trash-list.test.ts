/**
 * `GET /api/folders/:id/trash` — the query plan, and the response.
 *
 * Issue #83 was a plan regression, not a wrong answer: the predicate was
 * paraphrased into a shape the planner could no longer prove the partial
 * `deleted_at` index subsumed, so a five-row response read every asset in the
 * library. SQLite has exactly the same failure mode — `assets_trashed` is
 * partial over `deleted_at IS NOT NULL`, and a query whose own `WHERE` stops
 * implying that loses the index silently — so the plan is still asserted here
 * rather than left to a timing that a twenty-row test database cannot measure.
 *
 * The route handler reaches `sqliteDb()` with no override, so the correctness
 * half installs its database as the process-wide handle for the block.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import type { Database } from 'bun:sqlite';
import { ObjectId } from '../db/object-id.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { folderTrashStatement } from '../db/sqlite/repos/folder-assets.repo.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { foldersRoutes } from './folders.ts';

const FOLDER_PATH = '/srv/lib';

let live: LiveTestDatabase;
let folderId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  folderId = insertFolder(live.db, { path: FOLDER_PATH, slug: 'trash-list-lib' });
  // The library-roots cache is process-wide, so a sibling test's roots would
  // otherwise answer this one's path resolution.
  invalidateLibraryRoots();
});

afterEach(() => {
  live.close();
  invalidateLibraryRoots();
});

/** The planner's own description of how it will run a statement. */
function plan(db: Database, sql: string, ...params: Array<string | number>): string {
  const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
  return rows.map((row) => row.detail).join('\n');
}

/**
 * Seed `liveCount` live rows and `trashedCount` user-trashed rows in the
 * library, newest-deleted first. Returns the trashed asset ids in that order.
 */
function seed(liveCount: number, trashedCount: number): string[] {
  for (let i = 0; i < liveCount; i++) {
    const assetId = insertAsset(live.db);
    insertLocation(live.db, { assetId, libraryId: folderId, path: '', filename: `live-${i}.jpg` });
  }
  const now = Date.now();
  const trashed: string[] = [];
  for (let i = 0; i < trashedCount; i++) {
    const assetId = insertAsset(live.db);
    insertLocation(live.db, {
      assetId,
      libraryId: folderId,
      path: '.maple-trash',
      filename: `trash-${i}.jpg`,
    });
    run(
      live.db,
      `UPDATE assets SET deleted_at = ?, original_path = ? WHERE id = ?`,
      new Date(now - i * 1000).toISOString(),
      `${FOLDER_PATH}/trash-${i}.jpg`,
      assetId,
    );
    trashed.push(assetId);
  }
  return trashed;
}

describe('the trash page plan', () => {
  it('seeks the partial assets_trashed index instead of scanning the library', () => {
    const statement = folderTrashStatement(new ObjectId(folderId), { cursor: null, limit: 101 });
    const detail = plan(live.db, statement.sql, ...statement.params);

    // The whole point of #83: the trashed rows lead, and the library scope is
    // a probe per candidate rather than the driving scan.
    expect(detail).toContain('assets_trashed');
    expect(detail).not.toContain('SCAN a');
  });

  it('keeps the index on the cursor branch too', () => {
    // The cursor predicate is where #83 actually reintroduced itself: the base
    // predicate was fixed and the seek branch was not.
    const cursor = `${new Date().toISOString()}|${new ObjectId().toHexString()}`;
    const statement = folderTrashStatement(new ObjectId(folderId), { cursor, limit: 101 });
    const detail = plan(live.db, statement.sql, ...statement.params);

    expect(detail).toContain('assets_trashed');
    expect(detail).not.toContain('SCAN a');
  });

  it('ignores a malformed cursor rather than binding it', () => {
    const statement = folderTrashStatement(new ObjectId(folderId), {
      cursor: 'nonsense-with-no-separator',
      limit: 101,
    });
    // Library id and limit only — the seek contributed nothing.
    expect(statement.params).toHaveLength(2);
  });
});

describe('GET /api/folders/:id/trash — response correctness', () => {
  function get(query = ''): Promise<Response> {
    const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
    return app.handle(new Request(`http://localhost/api/folders/${folderId}/trash${query}`));
  }

  it('returns the trashed assets and nothing else', async () => {
    seed(20, 5);

    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ filename: string; deleted_at: string }>;
      next_cursor: string | null;
    };
    expect(body.items.length).toBe(5);
    expect(body.next_cursor).toBeNull();
    for (const item of body.items) {
      expect(item.filename.startsWith('trash-')).toBe(true);
      expect(typeof item.deleted_at).toBe('string');
    }
    // Sort is deleted_at desc — descending order over the returned set.
    for (let i = 1; i < body.items.length; i++) {
      const prev = body.items[i - 1]!;
      const cur = body.items[i]!;
      expect(prev.deleted_at >= cur.deleted_at).toBe(true);
    }
  });

  it('pages with a cursor and stops when the page is the last one', async () => {
    seed(0, 5);

    const first = (await (await get('?limit=2')).json()) as {
      items: Array<{ filename: string }>;
      next_cursor: string | null;
    };
    expect(first.items.map((i) => i.filename)).toEqual(['trash-0.jpg', 'trash-1.jpg']);
    expect(first.next_cursor).not.toBeNull();

    const second = (await (
      await get(`?limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`)
    ).json()) as { items: Array<{ filename: string }>; next_cursor: string | null };
    expect(second.items.map((i) => i.filename)).toEqual(['trash-2.jpg', 'trash-3.jpg']);

    const third = (await (
      await get(`?limit=2&cursor=${encodeURIComponent(second.next_cursor!)}`)
    ).json()) as { items: Array<{ filename: string }>; next_cursor: string | null };
    expect(third.items.map((i) => i.filename)).toEqual(['trash-4.jpg']);
    expect(third.next_cursor).toBeNull();
  });

  it('lists reaped rows alongside user-trashed rows, tagged reason "reaped" (#2977)', async () => {
    seed(2, 1); // one user-trashed row

    // One reaped row: no original_path, its location points at the (gone)
    // original library path, asset-level deleted_at plus the discriminator.
    const reapedId = insertAsset(live.db);
    insertLocation(live.db, {
      assetId: reapedId,
      libraryId: folderId,
      path: 'sub',
      filename: 'gone.dng',
      missingSince: '2026-08-01T00:00:00.000Z',
    });
    run(
      live.db,
      `UPDATE assets SET deleted_at = ?, deleted_reason = 'reaped' WHERE id = ?`,
      new Date().toISOString(),
      reapedId,
    );

    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        filename: string;
        original_relative_path: string;
        trash_relative_path: string;
        reason: string;
      }>;
    };
    expect(body.items.length).toBe(2);
    const reaped = body.items.find((i) => i.filename === 'gone.dng');
    expect(reaped).toBeDefined();
    expect(reaped!.reason).toBe('reaped');
    expect(reaped!.original_relative_path).toBe('sub/gone.dng');
    expect(reaped!.trash_relative_path).toBe('sub/gone.dng');
    const user = body.items.find((i) => i.filename === 'trash-0.jpg');
    expect(user).toBeDefined();
    expect(user!.reason).toBe('user');
  });
});
