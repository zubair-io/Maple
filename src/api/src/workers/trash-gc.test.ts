/**
 * trash-gc tests (#3787).
 *
 * Two things are worth pinning here and they are not the same thing.
 *
 * The first is the sweep's *cost*: it runs on a daily timer over the whole
 * library, so the candidate query has to seek the partial index that holds only
 * trashed rows rather than read every asset. That was the production bug the
 * Mongo version of this file was written for — the predicate had to be spelled
 * a particular way or the planner fell back to a collection scan — and SQLite
 * has the same failure mode with a partial index, so the plan is asserted
 * rather than assumed. The statement under test is whatever `listTrashedBefore`
 * actually issues, recorded through the handle it is given, so paraphrasing the
 * predicate in the repository fails this test instead of quietly costing a scan.
 *
 * The second is what the sweep does to the filesystem: the file, its sidecars,
 * and the one case where it must touch neither (#2977).
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { listTrashedBefore } from '../db/repos/assets.sweeps.ts';
import type { SqliteDb } from '../db/repos/db-handle.ts';
import type { SqlParams, SqlValue } from '../db/sqlite/protocol.ts';
import {
  createLiveTestDatabase,
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  testSqliteDb,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots, setLibraryRootsForTests } from '../indexer/libraries.cache.ts';
import { runTrashGcOnce } from './trash-gc.ts';

const DAY_MS = 86_400_000;

/** A statement a repository issued, as it was issued. */
interface Issued {
  sql: string;
  params: SqlParams | undefined;
}

/**
 * A handle that passes everything through and keeps a note of what it read.
 *
 * The point is to get at the repository's own SQL without copying it into the
 * test: a copy would keep passing after the repository's predicate changed,
 * which is precisely the regression being guarded against.
 */
function recordingDb(inner: SqliteDb, reads: Issued[]): SqliteDb {
  return {
    read: (sql, params) => {
      reads.push({ sql, params });
      return inner.read(sql, params);
    },
    write: (sql, params) => inner.write(sql, params),
    transaction: (statements) => inner.transaction(statements),
  };
}

/** The planner's own description of how it will run a statement. */
function plan(db: Database, issued: Issued): string {
  const params = (issued.params === undefined ? [] : issued.params) as SqlValue[];
  const rows = db.query(`EXPLAIN QUERY PLAN ${issued.sql}`).all(...params) as Array<{
    detail: string;
  }>;
  return rows.map((row) => row.detail).join('\n');
}

/** Register a library root and drop the process-wide roots cache onto it. */
function registerLibrary(db: Database, root: string): string {
  const libraryId = insertFolder(db, { path: root });
  invalidateLibraryRoots();
  return libraryId;
}

function trashedAsset(
  db: Database,
  args: { libraryId: string; filename: string; deletedAt: string; reason?: string },
): string {
  const id = insertAsset(db, { deletedAt: args.deletedAt });
  if (args.reason !== undefined) {
    run(db, `UPDATE assets SET deleted_reason = ? WHERE id = ?`, args.reason, id);
  }
  insertLocation(db, {
    assetId: id,
    libraryId: args.libraryId,
    path: '',
    filename: args.filename,
  });
  return id;
}

function assetIds(db: Database): string[] {
  return (db.query(`SELECT id FROM assets ORDER BY id`).all() as Array<{ id: string }>).map(
    (row) => row.id,
  );
}

// The roots cache is process-wide, so a library registered by one test would
// otherwise still resolve in the next one — against a database that has been
// disposed.
afterEach(() => {
  invalidateLibraryRoots();
});

describe('trash-gc candidate query', () => {
  it('seeks the trashed partial index instead of scanning the library', async () => {
    using handle = await createTestDatabase();
    const libraryId = insertFolder(handle.db);
    const now = Date.now();
    const oldIso = new Date(now - 60 * DAY_MS).toISOString();
    const cutoffIso = new Date(now - 30 * DAY_MS).toISOString();

    // Live rows outnumber trashed ones, which is the shape that makes a scan
    // expensive and an index cheap.
    for (let i = 0; i < 50; i++) {
      insertLocation(handle.db, {
        assetId: insertAsset(handle.db),
        libraryId,
        filename: `live-${i}.jpg`,
      });
    }
    for (let i = 0; i < 3; i++) {
      trashedAsset(handle.db, { libraryId, filename: `trash-${i}.jpg`, deletedAt: oldIso });
    }

    const reads: Issued[] = [];
    const found = await listTrashedBefore(cutoffIso, recordingDb(testSqliteDb(handle.db), reads));
    expect(found.length).toBe(3);

    const detail = plan(handle.db, reads[0]!);
    expect(detail).toContain('assets_trashed');
    expect(detail).not.toContain('SCAN assets');
  });
});

describe('runTrashGcOnce', () => {
  it('purges only rows older than the cutoff', async () => {
    using live = await createLiveTestDatabase();
    const root = mkdtempSync(join(tmpdir(), 'maple-trash-gc-'));
    const libraryId = registerLibrary(live.db, root);
    const now = Date.now();

    for (const name of ['old.jpg', 'new.jpg']) writeFileSync(join(root, name), 'x');

    const old = trashedAsset(live.db, {
      libraryId,
      filename: 'old.jpg',
      deletedAt: new Date(now - 60 * DAY_MS).toISOString(),
    });
    const fresh = trashedAsset(live.db, {
      libraryId,
      filename: 'new.jpg',
      deletedAt: new Date(now - 1 * DAY_MS).toISOString(),
    });
    const liveAsset = insertAsset(live.db);
    insertLocation(live.db, { assetId: liveAsset, libraryId, path: '', filename: 'live.jpg' });

    const summary = await runTrashGcOnce({ retentionDays: 30 });
    expect(summary).toEqual({ scanned: 1, purged: 1, errors: 0 });

    expect(assetIds(live.db).sort()).toEqual([fresh, liveAsset].sort());
    expect(assetIds(live.db)).not.toContain(old);
    expect(existsSync(join(root, 'old.jpg'))).toBe(false);
    expect(existsSync(join(root, 'new.jpg'))).toBe(true);
  });

  it('unlinks the paired sidecars alongside the purged original', async () => {
    using live = await createLiveTestDatabase();
    const root = mkdtempSync(join(tmpdir(), 'maple-trash-gc-sidecars-'));
    const libraryId = registerLibrary(live.db, root);

    writeFileSync(join(root, 'shot.dng'), 'x');
    writeFileSync(join(root, 'shot.xmp'), '<xmp/>');
    // A neighbour that merely starts with the same stem is not a paired
    // sidecar and must survive the purge.
    writeFileSync(join(root, 'shot (2).xmp'), '<xmp/>');

    trashedAsset(live.db, {
      libraryId,
      filename: 'shot.dng',
      deletedAt: new Date(Date.now() - 60 * DAY_MS).toISOString(),
    });

    const summary = await runTrashGcOnce({ retentionDays: 30 });
    expect(summary).toEqual({ scanned: 1, purged: 1, errors: 0 });

    expect(existsSync(join(root, 'shot.dng'))).toBe(false);
    expect(existsSync(join(root, 'shot.xmp'))).toBe(false);
    expect(existsSync(join(root, 'shot (2).xmp'))).toBe(true);
  });

  it('tolerates a file that is already gone', async () => {
    using live = await createLiveTestDatabase();
    const root = mkdtempSync(join(tmpdir(), 'maple-trash-gc-enoent-'));
    const libraryId = registerLibrary(live.db, root);

    // Nothing was ever written at this path — the previous pass got as far as
    // the unlink and died before the row went away.
    trashedAsset(live.db, {
      libraryId,
      filename: 'vanished.dng',
      deletedAt: new Date(Date.now() - 60 * DAY_MS).toISOString(),
    });

    const summary = await runTrashGcOnce({ retentionDays: 30 });
    expect(summary).toEqual({ scanned: 1, purged: 1, errors: 0 });
    expect(assetIds(live.db)).toEqual([]);
  });

  it('purges a reaped row past retention WITHOUT touching the file at its stored path (#2977)', async () => {
    using live = await createLiveTestDatabase();
    const root = mkdtempSync(join(tmpdir(), 'maple-trash-gc-reaped-'));
    const libraryId = registerLibrary(live.db, root);

    // The photo quietly RETURNED to its original location after the reap (no
    // revive ran yet). The purge must be a pure DB delete — a reaped row has no
    // trashed copy, and its locations point at ORIGINAL library paths that may
    // hold a real photo again.
    writeFileSync(join(root, 'back.jpg'), 'real-photo-bytes');
    writeFileSync(join(root, 'back.xmp'), '<xmp/>');

    trashedAsset(live.db, {
      libraryId,
      filename: 'back.jpg',
      deletedAt: new Date(Date.now() - 31 * DAY_MS).toISOString(),
      reason: 'reaped',
    });

    const summary = await runTrashGcOnce({ retentionDays: 30 });
    expect(summary).toEqual({ scanned: 1, purged: 1, errors: 0 });
    expect(assetIds(live.db)).toEqual([]);

    expect(existsSync(join(root, 'back.jpg'))).toBe(true);
    expect(existsSync(join(root, 'back.xmp'))).toBe(true);
  });

  it('leaves a reaped row inside the retention window untouched', async () => {
    using live = await createLiveTestDatabase();
    const root = mkdtempSync(join(tmpdir(), 'maple-trash-gc-fresh-reap-'));
    const libraryId = registerLibrary(live.db, root);
    const id = trashedAsset(live.db, {
      libraryId,
      filename: 'recent.jpg',
      deletedAt: new Date(Date.now() - 1 * DAY_MS).toISOString(),
      reason: 'reaped',
    });

    const summary = await runTrashGcOnce({ retentionDays: 30 });
    expect(summary).toEqual({ scanned: 0, purged: 0, errors: 0 });
    expect(assetIds(live.db)).toEqual([id]);
  });

  it('counts an asset whose library root is gone as an error and keeps the row', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db);
    // The library was unregistered after the asset was trashed, so no absolute
    // path can be composed. That is a condition an operator can fix, so the row
    // has to survive for the pass that runs after they do.
    setLibraryRootsForTests(new Map());
    const id = trashedAsset(live.db, {
      libraryId,
      filename: 'orphan.jpg',
      deletedAt: new Date(Date.now() - 60 * DAY_MS).toISOString(),
    });

    const summary = await runTrashGcOnce({ retentionDays: 30 });
    expect(summary).toEqual({ scanned: 1, purged: 0, errors: 1 });
    expect(assetIds(live.db)).toEqual([id]);
  });
});
