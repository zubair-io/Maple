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
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { retryOnBusy } from '../busy-retry.ts';

const log = childLogger('changes-repo-sqlite');

export type { SqliteDb } from './db-handle.ts';

/** Primary key of the `server_state` row holding the change-feed counter. */
const CURSOR_ROW_ID = 'asset_changes_cursor';

/**
 * Allocate the next cursor: one past the larger of the counter and the journal.
 *
 * Reading the journal as well as the counter looks redundant — the counter is
 * the allocator and the journal only ever receives what it hands out — but it
 * is what keeps the two from disagreeing, and a disagreement here is fatal
 * rather than cosmetic. `cursor` is the primary key, so a counter that has
 * fallen behind the journal mints a value a row already occupies, the insert is
 * rejected, and {@link recordAndPublishAssetChange}'s best-effort handler
 * swallows it: the feed stops emitting from boot with nothing but a warn line to
 * say so. The way to get there is the Mongo→SQLite cutover (#3752) importing
 * `asset_changes` rows without also seeding this row, and the repair costs a
 * `MAX(cursor)` that SQLite answers from the end of the primary-key b-tree
 * rather than a scan, inside the batch that was already being written.
 *
 * `COALESCE` guards the one way this row could hold a NULL `seq`: `server_state`
 * is shared with string-valued singletons such as the JWT secret, whose rows
 * leave the column unset, and `NULL + 1` is NULL rather than an error. The
 * journal side needs the same guard for the ordinary empty-table case, which
 * retention pruning (#3741) makes routine rather than first-boot-only.
 */
const BUMP_CURSOR_SQL = `
  INSERT INTO server_state (id, seq)
  VALUES (?, (SELECT COALESCE(MAX(cursor), 0) FROM asset_changes) + 1)
  ON CONFLICT (id) DO UPDATE SET
    seq = MAX(
      COALESCE(server_state.seq, 0),
      (SELECT COALESCE(MAX(cursor), 0) FROM asset_changes)
    ) + 1`;

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

/**
 * The three numbers {@link isChangeCursorTooOld} compares, in one round trip.
 * Each is a b-tree endpoint or a primary-key lookup, so the whole row costs
 * three seeks; Mongo needs three separate queries to answer the same question.
 */
const RETENTION_FLOOR_SQL = `
  SELECT (SELECT MIN(cursor) FROM asset_changes)        AS lowest,
         (SELECT MAX(cursor) FROM asset_changes)        AS highest,
         (SELECT seq FROM server_state WHERE id = ?)    AS allocated`;

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
export function __resetChangeFolderPathCacheForTests(): void {
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

/**
 * Persist before returning the exact row for callers that publish durably.
 *
 * Retries a write the writer was too busy to take. This is the one failure mode
 * the port introduces: Mongo had no global write lock, while SQLite funnels
 * every writer in every child process through a single one, so a change row
 * emitted mid-batch can lose the race in a way it never did before. The caller
 * above treats a failure as best-effort and logs it, which would turn that into
 * a silently dropped event — the client is told it is current and the edit never
 * reaches it.
 */
export async function recordAssetChangeRow(
  dbOverride: SqliteDb | undefined,
  input: RecordChangeInput,
): Promise<AssetChangeWithId> {
  const db = sqliteDb(dbOverride);
  const relativePath = input.relative_path ?? null;
  try {
    return await retryOnBusy(() => writeChangeRow(db, input, relativePath));
  } catch (err) {
    log.error({ err, kind: input.kind }, 'recordAssetChange: write failed');
    throw err;
  }
}

/** One attempt: allocate and insert in a single batch, and report the row. */
async function writeChangeRow(
  db: SqliteDb,
  input: RecordChangeInput,
  relativePath: string | null,
): Promise<AssetChangeWithId> {
  // Stamped per attempt so `at` reports when the row actually landed.
  const at = new Date();
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
}

export interface ListChangesQuery {
  since: number;
  limit: number;
}

export async function listChangesSince(
  dbOverride: SqliteDb | undefined,
  q: ListChangesQuery,
): Promise<AssetChangeWithId[]> {
  const db = sqliteDb(dbOverride);
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
    const db = sqliteDb(dbOverride);
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
  // An empty path is treated as no path, which is what the Mongo repo's
  // truthiness check did. `folders.path` is NOT NULL UNIQUE but carries no
  // non-empty CHECK, and an empty root makes every prefix match: the defensive
  // "outside the root" branch never fires, and `computeRelativePath('', '/srv/
  // photos/a.dng')` answers `srv/photos/a.dng` — a plausible-looking path the
  // File Provider would route per-folder invalidation on. Null is the honest
  // answer; the extension falls back to `abs_path`.
  if (!folderPath) return null;
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
  const db = sqliteDb(dbOverride);
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
  const db = sqliteDb(dbOverride);
  const rows = await db.read<{ seq: number | null }>(ALLOCATED_CURSOR_SQL, [CURSOR_ROW_ID]);
  return rows[0]?.seq ?? 0;
}

/** What {@link isChangeCursorTooOld} reports: the verdict, and where to resume. */
export interface ChangeCursorAge {
  /** True when the row after `since` has been pruned and cannot be served. */
  tooOld: boolean;
  /** The highest cursor the server knows about — what a 409 names. */
  current: number;
}

/**
 * Whether a client's saved cursor predates the retained journal.
 *
 * This is the polling route's half of the 409 the SSE route already answers,
 * and the two have to agree or a File Provider client gets a different verdict
 * depending on which transport it happens to be on. `ChangeBus.isCursorReplayable`
 * asks the same question of the in-memory ring buffer; this asks it of the
 * journal, whose floor is set by retention pruning (#3741) rather than by a
 * capacity limit.
 *
 * Without the check, a Mac that slept across a retention sweep polls `?since=2`,
 * is handed the rows above the new floor with a 200, advances its anchor past
 * them and never learns it skipped everything in between.
 * `RemoteCatalog+Changes.swift` throws `StaleCursorError` on a 409 and
 * `WorkingSetEnumerator.swift` maps that to `syncAnchorExpired`, so the full
 * re-enumeration path the client already implements is reachable only if the
 * server says 409.
 *
 * Ported to the same name, parameters and return shape as the Mongo function
 * #3755 adds, deliberately: the cutover (#3752) swaps the route's import path
 * and the guard has to survive that swap unchanged. See this PR's reply on
 * #3766 for how the two land together.
 */
export async function isChangeCursorTooOld(
  dbOverride: SqliteDb | undefined,
  since: number,
): Promise<ChangeCursorAge> {
  const db = sqliteDb(dbOverride);
  const rows = await db.read<{
    lowest: number | null;
    highest: number | null;
    allocated: number | null;
  }>(RETENTION_FLOOR_SQL, [CURSOR_ROW_ID]);
  const row = rows[0];
  const current = Math.max(row?.highest ?? 0, row?.allocated ?? 0);
  const lowest = row?.lowest ?? null;
  // An empty journal cannot distinguish "swept" from "never wrote anything", so
  // the counter decides: a client at the allocation watermark is current, and
  // anyone below it missed rows that no longer exist.
  if (lowest === null) return { tooOld: since < current, current };
  // `since + 1` is the next row the client wants. If that is below the floor it
  // was pruned, and everything up to the floor went with it.
  return { tooOld: since + 1 < lowest, current };
}
