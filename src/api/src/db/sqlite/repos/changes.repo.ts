/**
 * Change-feed repository — the SQLite port of `db/changes.repo.ts` (#3747).
 *
 * This is the journal the File Provider extension syncs against: one row per
 * asset mutation, ordered by a server-allocated `cursor`, plus the counter row
 * in `server_state` that mints those cursors. Every function the Mongo repo
 * exports has an equivalent here with the same name, the same parameters and
 * the same return type, so the cutover (#3752) changes an import path and
 * nothing else. MongoDB is still the live database; this module is wired to no
 * route yet and the Mongo repo is untouched, the same staged shape #3746 landed
 * the assets port in.
 *
 * ## The gap this port closes
 *
 * On Mongo a write is two operations: `$inc` the counter document, then insert
 * the row. Per-document atomicity makes the counter safe, but nothing binds the
 * two steps together — if the insert fails after the allocation succeeded, the
 * cursor is spent and the event it was meant to carry never exists. The Mongo
 * module's header documents that as a tolerated wart and tells consumers to
 * cope with gaps.
 *
 * Here both steps are one `BEGIN IMMEDIATE` batch on the single writer, so
 * either a cursor and its row both exist or neither does. Two consequences
 * worth being explicit about:
 *
 *   - `allocateCursor` is deliberately **not** part of the ported surface. A
 *     verb that hands a caller a cursor with no row attached is precisely the
 *     window this port removes, it had no caller outside the Mongo module and
 *     its own test, and it cannot be made atomic through the pool's three
 *     primitives anyway — a write reports `changes` and `lastInsertRowid`, not
 *     the value it just computed.
 *   - The cursor still comes back from the write, because
 *     `asset_changes.cursor` is `INTEGER PRIMARY KEY` and therefore a rowid
 *     alias: `lastInsertRowid` on the insert *is* the allocated cursor.
 *
 * ## Gaps are still real, and the 409 path still matters
 *
 * Retention pruning (#3741) deletes old rows by design, so a client's saved
 * cursor can still fall below anything the journal holds. Consumers must go on
 * tolerating gaps: the poll route filters `cursor > since` and returns what is
 * there, and the SSE route refuses a cursor the bus cannot replay with a 409
 * that drives a full re-enumeration. What changed is only that a gap is now
 * always someone's deliberate deletion rather than possibly a failed insert.
 *
 * ## Round trips
 *
 * `recordAndPublishAssetChange` resolves the library root's path, computes the
 * folder-relative path and writes the row. The path resolution stays in
 * TypeScript, sharing {@link computeRelativePath} with the Mongo repo rather
 * than growing a second implementation of the same prefix rules in SQL — the
 * argument `assets.mutations.ts` makes about the search blob. It is served from
 * the same tiny per-process cache the Mongo repo uses, so every emit after the
 * first for a given library is one round trip: a single atomic batch carrying
 * the cursor allocation and the row insert together, against three separate
 * operations on Mongo.
 */

import { ObjectId } from 'mongodb';
import { child as childLogger } from '../../../log.ts';
import { getChangeBus } from '../../../runtime/change-bus.ts';
import type { AssetChangeKind, AssetChangeWithId } from '../../schema.ts';
import { repoDb, type SqliteDb } from './db-handle.ts';

const log = childLogger('changes-repo-sqlite');

export type { SqliteDb } from './db-handle.ts';

/** Primary key of the `server_state` row holding the change-feed counter. */
const CURSOR_ROW_ID = 'asset_changes_cursor';

/**
 * Allocate the next cursor.
 *
 * `COALESCE` guards the one way this row could hold a NULL `seq`: `server_state`
 * is shared with string-valued singletons such as the JWT secret, whose rows
 * leave the column unset, and `NULL + 1` is NULL rather than an error.
 */
const BUMP_CURSOR_SQL = `
  INSERT INTO server_state (id, seq) VALUES (?, 1)
  ON CONFLICT (id) DO UPDATE SET seq = COALESCE(seq, 0) + 1`;

/** Write the row at the cursor the preceding statement just allocated. */
const INSERT_CHANGE_SQL = `
  INSERT INTO asset_changes (cursor, asset_id, folder_id, kind, abs_path, relative_path, at)
  VALUES ((SELECT seq FROM server_state WHERE id = ?), ?, ?, ?, ?, ?, ?)`;

const FOLDER_PATH_SQL = `SELECT path FROM folders WHERE id = ?`;

/** Served by the `asset_changes` primary key, which is the cursor itself. */
const LIST_CHANGES_SQL = `
  SELECT cursor, asset_id, folder_id, kind, abs_path, relative_path, at
    FROM asset_changes
   WHERE cursor > ?
   ORDER BY cursor
   LIMIT ?`;

const HIGHEST_CURSOR_SQL = `SELECT MAX(cursor) AS cursor FROM asset_changes`;

const ALLOCATED_CURSOR_SQL = `SELECT seq FROM server_state WHERE id = ?`;

/** The columns {@link LIST_CHANGES_SQL} returns, before any conversion. */
interface ChangeRow {
  cursor: number;
  asset_id: string | null;
  folder_id: string | null;
  kind: AssetChangeKind;
  abs_path: string | null;
  relative_path: string | null;
  at: string;
}

// Tiny per-process cache for the library root's path. Folders are effectively
// immutable at the path level (rename is not a supported operation in the
// current schema) so we never invalidate; a process restart picks up any rare
// change. This is what keeps `recordAndPublishAssetChange` at a single round
// trip per emit after the first hit.
const folderPathCache: Map<string, string> = new Map();

/** Test hook — drops the in-process folder.path cache. */
export function __resetFolderPathCacheForTests(): void {
  folderPathCache.clear();
}

async function lookupFolderPath(db: SqliteDb, folderId: ObjectId): Promise<string | null> {
  const key = folderId.toHexString();
  const hit = folderPathCache.get(key);
  if (hit !== undefined) return hit;
  const rows = await db.read<{ path: string }>(FOLDER_PATH_SQL, [key]);
  const path = rows[0]?.path;
  if (typeof path !== 'string') return null;
  folderPathCache.set(key, path);
  return path;
}

/**
 * The `_id` a change row reports.
 *
 * `asset_changes` has no separate identity under SQLite — the cursor is the
 * primary key — so the field is derived from the cursor rather than stored.
 * It exists because `AssetChangeWithId` is what every consumer's signature
 * says, and no consumer reads it: the SSE projection in `routes/changes.ts`
 * strips it, and the change bus keys on the cursor. Deriving it rather than
 * minting a random one keeps two reads of the same row equal.
 */
function syntheticId(cursor: number): ObjectId {
  return new ObjectId(cursor.toString(16).padStart(24, '0'));
}

function toObjectId(hex: string | null): ObjectId | null {
  return hex === null ? null : new ObjectId(hex);
}

function toChange(row: ChangeRow): AssetChangeWithId {
  return {
    _id: syntheticId(row.cursor),
    cursor: row.cursor,
    asset_id: toObjectId(row.asset_id),
    folder_id: toObjectId(row.folder_id),
    kind: row.kind,
    abs_path: row.abs_path,
    relative_path: row.relative_path,
    at: new Date(row.at),
  };
}

/**
 * Compute the asset path relative to its folder root. Returns:
 *   - `""` if absPath is the folder root itself
 *   - `"sub/dir/file.dng"` for nested assets
 *   - `null` if absPath doesn't fall under the folder root (defensive —
 *     callers log a warn and persist null rather than a wrong path).
 *
 * Path separator is forward-slash throughout (the server stores POSIX paths;
 * the apple FP extension consumes them the same way).
 *
 * Copied from the Mongo repo rather than imported from it, and the copy is
 * deliberate: importing would pull the Mongo client's whole module graph into
 * this file for one pure function, and would leave a dangling import when the
 * cutover (#3752) deletes that module. The parity test pins the two versions
 * to the same type, and the duplication ends with the Mongo repo.
 */
// fallow-ignore-next-line code-duplication
export function computeRelativePath(folderPath: string, absPath: string): string | null {
  // Normalise the folder path so a trailing slash on the folder row doesn't
  // break the prefix-match.
  const rootNoTrail = folderPath.endsWith('/') ? folderPath.slice(0, -1) : folderPath;
  if (absPath === rootNoTrail) return '';
  const prefix = rootNoTrail + '/';
  if (!absPath.startsWith(prefix)) return null;
  return absPath.slice(prefix.length);
}

export interface RecordChangeInput {
  kind: AssetChangeKind;
  asset_id: ObjectId | null;
  folder_id: ObjectId | null;
  abs_path: string | null;
  /**
   * Path relative to the folder root. Optional at this layer — the high-level
   * `recordAndPublishAssetChange` computes it from `folder.path` + `abs_path`.
   * Callers that drive the repo directly (tests, the change-feed tailer) may
   * pass it or leave it undefined. Stored as `null` when not provided so old
   * rows look the same as absent-on-write rows.
   */
  relative_path?: string | null;
}

/**
 * Allocate a cursor, write the change row, return the cursor.
 *
 * Throws if the write fails, and nothing is left behind when it does — the
 * allocation rolls back with the insert. Callers should still not block their
 * primary write on this: the recommended pattern is to call it AFTER a
 * successful asset mutation and let exceptions bubble only for logging.
 */
export async function recordAssetChange(
  dbOverride: SqliteDb | undefined,
  input: RecordChangeInput,
): Promise<number> {
  return (await recordAssetChangeRow(dbOverride, input)).cursor;
}

/** Persist before returning the exact row for callers that publish durably. */
export async function recordAssetChangeRow(
  dbOverride: SqliteDb | undefined,
  input: RecordChangeInput,
): Promise<AssetChangeWithId> {
  const db = repoDb(dbOverride);
  const at = new Date();
  const relativePath = input.relative_path ?? null;
  try {
    const results = await db.transaction([
      { sql: BUMP_CURSOR_SQL, params: [CURSOR_ROW_ID] },
      {
        sql: INSERT_CHANGE_SQL,
        params: [
          CURSOR_ROW_ID,
          input.asset_id?.toHexString() ?? null,
          input.folder_id?.toHexString() ?? null,
          input.kind,
          input.abs_path,
          relativePath,
          at.toISOString(),
        ],
      },
    ]);
    // `cursor` is an INTEGER PRIMARY KEY, so the insert's rowid is the value
    // the counter just handed out.
    const cursor = results[1]!.lastInsertRowid;
    return {
      _id: syntheticId(cursor),
      cursor,
      asset_id: input.asset_id,
      folder_id: input.folder_id,
      kind: input.kind,
      abs_path: input.abs_path,
      relative_path: relativePath,
      at,
    };
  } catch (err) {
    log.error({ err, kind: input.kind }, 'recordAssetChange: write failed');
    throw err;
  }
}

export interface ListChangesQuery {
  since: number;
  limit: number;
}

export async function listChangesSince(
  dbOverride: SqliteDb | undefined,
  q: ListChangesQuery,
): Promise<AssetChangeWithId[]> {
  const db = repoDb(dbOverride);
  const limit = Math.min(Math.max(q.limit, 1), 1000);
  const rows = await db.read<ChangeRow>(LIST_CHANGES_SQL, [q.since, limit]);
  return rows.map(toChange);
}

/**
 * High-level helper: record the change in SQLite AND publish to the in-process
 * bus so connected SSE clients see it immediately.
 *
 * Best-effort: errors are logged but never thrown. Change-row failures must
 * never fail the primary asset write — the system tolerates lost events via the
 * 409 stale-cursor path which triggers full re-enumeration.
 *
 * Resolves `relative_path` from the named folder root via a small in-process
 * cache so File Provider clients can route per-folder invalidation precisely.
 * This is the one place the folder.path lookup happens — pushing it here keeps
 * the ~12 call sites free of folder boilerplate. When the caller pre-computed
 * the relative path (tests, change-feed replay), we use that and skip the
 * lookup.
 *
 * `dbOverride` is for tests that want to target an isolated database.
 * Production callers omit it; the process-wide pool applies.
 */
export async function recordAndPublishAssetChange(
  input: RecordChangeInput,
  dbOverride?: SqliteDb,
): Promise<void> {
  try {
    const db = repoDb(dbOverride);
    const enriched: RecordChangeInput = {
      ...input,
      relative_path: await resolveRelativePath(db, input),
    };
    // Unlike the Mongo repo, which reconstructs a bus payload from the input to
    // avoid a second round trip, the write already hands back the exact row it
    // persisted — so the bus and the journal cannot disagree.
    getChangeBus().publish(await recordAssetChangeRow(db, enriched));
  } catch (err) {
    log.warn(
      { err, kind: input.kind, abs_path: input.abs_path },
      'recordAndPublishAssetChange failed (best-effort, ignoring)',
    );
  }
}

/** The relative path to persist: the caller's, or one derived from the root. */
async function resolveRelativePath(db: SqliteDb, input: RecordChangeInput): Promise<string | null> {
  const supplied = input.relative_path ?? null;
  if (supplied !== null || !input.folder_id || !input.abs_path) return supplied;
  const folderPath = await lookupFolderPath(db, input.folder_id);
  if (folderPath === null) return null;
  const relative = computeRelativePath(folderPath, input.abs_path);
  if (relative === null) {
    log.warn(
      {
        folder_id: input.folder_id.toHexString(),
        folder_path: folderPath,
        abs_path: input.abs_path,
      },
      'recordAndPublishAssetChange: abs_path is outside folder.path; storing null relative_path',
    );
  }
  return relative;
}

/** Returns the highest cursor currently in the journal, or 0 if it is empty. */
export async function highestCursor(dbOverride?: SqliteDb): Promise<number> {
  const db = repoDb(dbOverride);
  const rows = await db.read<{ cursor: number | null }>(HIGHEST_CURSOR_SQL);
  return rows[0]?.cursor ?? 0;
}

/**
 * The highest cursor ever *allocated*, or 0 on a server that has emitted none.
 *
 * This is not the same number as {@link highestCursor}, and the difference is
 * the whole point of the row: retention pruning empties the journal but never
 * touches the counter, so this is what a server still knows about history it no
 * longer stores. The change-feed tailer seeds the bus's high watermark from it
 * so a dormant client is told to re-enumerate rather than handed an empty
 * stream — see `runtime/sqlite/change-feed-tailer.ts`.
 */
export async function allocatedCursor(dbOverride?: SqliteDb): Promise<number> {
  const db = repoDb(dbOverride);
  const rows = await db.read<{ seq: number | null }>(ALLOCATED_CURSOR_SQL, [CURSOR_ROW_ID]);
  return rows[0]?.seq ?? 0;
}
