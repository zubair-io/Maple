/**
 * `discover_frontier` — the SQLite port of `workers/discover/frontier.repo.ts`
 * (#3751).
 *
 * The queue of directories a discover sweep still has to visit. It lives in the
 * database rather than on the heap so a walk's memory is O(one directory)
 * instead of O(tree), and a claim carries a lease so a crashed sweeper's
 * directory is retaken rather than stranded.
 *
 * Same function names, same parameters, same return types as the Mongo module,
 * so the cutover (#3752) swaps the import in `workers/discover/sweeper.ts` and
 * `workers/discover/index.ts` and nothing else.
 *
 * ## `_id` is the rowid, and that is deliberate
 *
 * `discover_frontier` has an `INTEGER PRIMARY KEY`, not the 24-character hex
 * every client-visible table uses (`docs/sqlite-schema.md` § keys lists it
 * among the internal tables). The Mongo document's `_id` is an `ObjectId`, so
 * the honest question is whether {@link FrontierDir} should convert.
 *
 * It should not, because no caller does anything with the value except hand it
 * straight back. Every use in the repository is `frontier.completeDir(dir._id)`
 * — three call sites in `sweeper.ts` plus the frontier's own tests — and none
 * of them compares it, serialises it, stores it or puts it on the wire. A
 * frontier row never leaves the server: it is created by a sweep and deleted by
 * the same sweep minutes later. Minting an ObjectId for it would cost 12 bytes
 * of index per row and a conversion in both directions, to make a number look
 * like something it is not.
 *
 * So {@link FrontierDir} declares `_id: number` and {@link completeDir} takes a
 * number. That is a type change the cutover commit has to compile through,
 * which is exactly the review it deserves.
 *
 * ## The claim is a compare-and-swap
 *
 * Mongo's `findOneAndUpdate` with a sort matches and writes in one server-side
 * step, so only one sweeper can win a directory. The SQLite pool has no
 * primitive that writes and returns rows — `read` runs on a read-only
 * connection and `write` reports only a row count — so {@link claimNextDir}
 * reads candidate ids and then claims one with the free-or-expired predicate
 * repeated in the `UPDATE`'s own `WHERE`. The winner is established by the row
 * count, not by the read, which is the same guarantee from the other side.
 */

import type { ObjectId } from 'mongodb';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toBool, toHex, toObjectId } from './values.ts';

/**
 * One directory still to visit.
 *
 * Mirrors the MongoDB frontier document field for field, except that `_id` is
 * the row's integer primary key — see the module comment.
 *
 * `hidden_ancestor` is always present rather than optional: the column is
 * `NOT NULL DEFAULT 0`, so "never written" is not a state a row can be in, and
 * the one caller tests `=== true`.
 */
export interface FrontierDir {
  _id: number;
  folder_id: ObjectId;
  dir_path: string;
  sweep_gen: number;
  claimed_at: number | null;
  enqueued_at: number;
  hidden_ancestor: boolean;
}

interface FrontierRow {
  id: number;
  folder_id: string;
  dir_path: string;
  sweep_gen: number;
  claimed_at: number | null;
  enqueued_at: number;
  hidden_ancestor: number;
}

/**
 * Free or lease-expired, spelled once so the candidate query and the
 * compare-and-swap cannot drift. `claimed_at` is an epoch-ms lease, NULL when
 * nobody holds the directory.
 */
const FREE_PREDICATE = `(claimed_at IS NULL OR claimed_at < ?)`;

const CANDIDATES_SQL = `
  SELECT id FROM discover_frontier
   WHERE folder_id = ? AND sweep_gen = ? AND ${FREE_PREDICATE}
   ORDER BY enqueued_at, id LIMIT 8`;

const CLAIM_SQL = `
  UPDATE discover_frontier SET claimed_at = ? WHERE id = ? AND ${FREE_PREDICATE}`;

const BY_ID_SQL = `
  SELECT id, folder_id, dir_path, sweep_gen, claimed_at, enqueued_at, hidden_ancestor
    FROM discover_frontier WHERE id = ?`;

function toFrontierDir(row: FrontierRow): FrontierDir {
  return {
    _id: row.id,
    folder_id: toObjectId(row.folder_id),
    dir_path: row.dir_path,
    sweep_gen: row.sweep_gen,
    claimed_at: row.claimed_at,
    enqueued_at: row.enqueued_at,
    hidden_ancestor: toBool(row.hidden_ancestor),
  };
}

/** Insert the root dir for a fresh generation (no-op if it already exists). */
export async function seedRoot(
  folderId: ObjectId,
  rootPath: string,
  gen: number,
  dbOverride?: SqliteDb,
): Promise<void> {
  await enqueueDirs(folderId, [rootPath], gen, false, dbOverride);
}

/**
 * Insert child directories for the current generation, ignoring duplicates.
 * `hiddenAncestor` records that the enqueuing parent is folder-hidden (its own
 * `.hidden` marker or an inherited one), so the subtree inherits the hide
 * (#2972).
 *
 * `ON CONFLICT DO NOTHING` against the `(folder_id, dir_path, sweep_gen)`
 * UNIQUE key replaces the Mongo version's error inspection. That code had to
 * issue an unordered `insertMany`, catch the bulk-write error, and decide
 * whether every per-document failure was a duplicate key (11000) before
 * swallowing it — because any other failure had to propagate or the sweep would
 * silently drop directories. The conflict clause makes the same distinction
 * declaratively: a duplicate is skipped, and any other constraint failure still
 * throws.
 */
export async function enqueueDirs(
  folderId: ObjectId,
  dirs: string[],
  gen: number,
  hiddenAncestor: boolean,
  dbOverride?: SqliteDb,
): Promise<void> {
  if (dirs.length === 0) return;
  const now = Date.now();
  const values = dirs.map(() => `(?, ?, ?, NULL, ?, ?)`).join(', ');
  await sqliteDb(dbOverride).write(
    `INSERT INTO discover_frontier
       (folder_id, dir_path, sweep_gen, claimed_at, enqueued_at, hidden_ancestor)
     VALUES ${values}
     ON CONFLICT (folder_id, dir_path, sweep_gen) DO NOTHING`,
    dirs.flatMap((dir) => [toHex(folderId), dir, gen, now, hiddenAncestor ? 1 : 0]),
  );
}

/**
 * Atomically claim the oldest free (or lease-expired) dir for `gen`.
 *
 * Two steps, and the second is the one that decides. The candidate read is
 * ordered exactly as the Mongo `sort` was — oldest enqueued first, id breaking
 * ties — and then each candidate is claimed with the free-or-expired predicate
 * repeated in the `UPDATE`'s `WHERE`. A row count of one means this caller took
 * the directory and no other sweeper can now touch it; a row count of zero
 * means a sibling claimed it in the gap, and the next candidate is tried. That
 * is why the read asks for several ids rather than one: under contention a
 * single candidate would make every loser return "nothing to do" while work
 * remained.
 *
 * Exhausting the candidates returns null. The caller polls, so a claim that
 * loses all eight races is a slightly delayed directory, never a lost one.
 */
export async function claimNextDir(
  folderId: ObjectId,
  gen: number,
  leaseMs: number,
  dbOverride?: SqliteDb,
): Promise<FrontierDir | null> {
  const db = sqliteDb(dbOverride);
  const now = Date.now();
  const lease = now + leaseMs;

  const candidates = await db.read<{ id: number }>(CANDIDATES_SQL, [toHex(folderId), gen, now]);
  for (const candidate of candidates) {
    const claimed = await db.write(CLAIM_SQL, [lease, candidate.id, now]);
    if (claimed.changes === 0) continue;
    const rows = await db.read<FrontierRow>(BY_ID_SQL, [candidate.id]);
    const row = rows[0];
    if (row !== undefined) return toFrontierDir(row);
  }
  return null;
}

/** Remove a finished dir from the frontier. */
export async function completeDir(id: number, dbOverride?: SqliteDb): Promise<void> {
  await sqliteDb(dbOverride).write(`DELETE FROM discover_frontier WHERE id = ?`, [id]);
}

/** Rows left for a generation (claimed or not). 0 ⇒ sweep of that gen done. */
export async function remainingForGen(
  folderId: ObjectId,
  gen: number,
  dbOverride?: SqliteDb,
): Promise<number> {
  const rows = await sqliteDb(dbOverride).read<{ n: number }>(
    `SELECT COUNT(*) AS n FROM discover_frontier WHERE folder_id = ? AND sweep_gen = ?`,
    [toHex(folderId), gen],
  );
  return rows[0]?.n ?? 0;
}
