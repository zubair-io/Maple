/**
 * `folders` — the SQLite port of the library-root registry (#3751).
 *
 * One row per registered library: where it lives on disk, the slug that
 * addresses it in URLs, the label a person reads, and the mirror roots its
 * writes fan out to. Production holds a handful of rows, and half the API
 * touches them — every asset DTO carries a `folder_id`, every filesystem
 * operation resolves a library root first, and the change feed turns an
 * absolute path into a library-relative one before it publishes.
 *
 * Like the other ported repositories, the functions here are named after the
 * operations the current code performs, because `folders` had no repository
 * module: the reads and writes were spelled inline across `routes/folders.ts`,
 * `routes/mirror.ts`, `fs/mirror-config.ts`, `indexer/libraries.cache.ts`,
 * `workers/discover/index.ts` and `db/changes.repo.ts`. The cutover (#3752)
 * replaces each of those with a call here.
 *
 * ## What is not here, and why
 *
 * There is no `updateFolderPath` and no `deleteFolder`, because nothing in the
 * application does either. A library root's `path` is written once at
 * registration and never changed — moving a library means registering the new
 * location — and there is no route that unregisters one. Both absences are
 * load-bearing; see {@link folderPath} below.
 *
 * There is no `setFolderFileCount` either. `file_count` is written once, as a
 * literal zero, by the registration insert; nothing updates it afterwards, so
 * a setter would be a function with no caller.
 *
 * ## The path cache, and the assumption underneath it
 *
 * `db/changes.repo.ts` keeps a process-local map of folder id → path so that
 * publishing a change costs one database round trip instead of two, and it
 * never invalidates an entry. Its comment says folders are "effectively
 * immutable at the path level", which is a statement about the code rather
 * than about the schema — nothing stopped a future route from adding a rename
 * and quietly making every cached path wrong.
 *
 * Moving the cache here is what makes the assumption safe rather than merely
 * true. This module is the only way to write the table, and it exposes no
 * function that can change a path. An insert cannot invalidate an existing
 * entry, because the row it creates has an id nothing has looked up yet. So
 * the cache cannot go stale unless someone adds a path-mutating function to
 * this file, at which point the invalidation is a line away rather than in
 * another module they may never read.
 */

import type { ObjectId, WithId } from 'mongodb';
import { newObjectIdHex } from '../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { nowIso, parseJson, toHex, toObjectId } from './values.ts';
import type { FolderDoc, MirrorLocation } from '../../schema.ts';

export type { SqliteDb } from './db-handle.ts';

interface FolderRow {
  id: string;
  path: string;
  slug: string;
  label: string;
  last_scan: string | null;
  file_count: number;
  created_at: string;
  mirrors: string | null;
}

const FOLDER_COLUMNS = `id, path, slug, label, last_scan, file_count, created_at, mirrors`;

function toFolder(row: FolderRow): WithId<FolderDoc> {
  const mirrors = parseJson<MirrorLocation[] | null>(row.mirrors, null);
  return {
    _id: toObjectId(row.id),
    path: row.path,
    slug: row.slug,
    label: row.label,
    last_scan: row.last_scan,
    file_count: row.file_count,
    created_at: row.created_at,
    // Absent rather than null when unset: `FolderDoc.mirrors` is optional and
    // `mirrors ?? []` at the call sites reads the same either way, but the DTO
    // the mirror route returns should not sprout a null field.
    ...(mirrors === null ? {} : { mirrors }),
  };
}

/** Every registered library, oldest first — the order the sidebar renders. */
export async function listFolders(dbOverride?: SqliteDb): Promise<WithId<FolderDoc>[]> {
  const rows = await sqliteDb(dbOverride).read<FolderRow>(
    `SELECT ${FOLDER_COLUMNS} FROM folders ORDER BY created_at ASC`,
  );
  return rows.map(toFolder);
}

/** One library by id, or `null`. */
export async function findFolderById(
  id: ObjectId,
  dbOverride?: SqliteDb,
): Promise<WithId<FolderDoc> | null> {
  const rows = await sqliteDb(dbOverride).read<FolderRow>(
    `SELECT ${FOLDER_COLUMNS} FROM folders WHERE id = ?`,
    [toHex(id)],
  );
  return rows[0] === undefined ? null : toFolder(rows[0]);
}

/**
 * One library by its absolute root path — the registration route's
 * already-registered check.
 */
export async function findFolderByPath(
  path: string,
  dbOverride?: SqliteDb,
): Promise<WithId<FolderDoc> | null> {
  const rows = await sqliteDb(dbOverride).read<FolderRow>(
    `SELECT ${FOLDER_COLUMNS} FROM folders WHERE path = ?`,
    [path],
  );
  return rows[0] === undefined ? null : toFolder(rows[0]);
}

/** A library root as the caches and the sweepers need it. */
export interface LibraryRoot {
  id: ObjectId;
  path: string;
  slug: string;
  label: string;
}

/**
 * Every library's identity and root path, without the mirror payload.
 *
 * Four callers want exactly this and nothing else: the slug → root cache that
 * resolves every public address, the discover sweeper's root list, the worker
 * bootstrap's watch list, and the library-roots map every `fileinfo` resolver
 * consults.
 */
export async function listLibraryRoots(dbOverride?: SqliteDb): Promise<LibraryRoot[]> {
  const rows = await sqliteDb(dbOverride).read<{
    id: string;
    path: string;
    slug: string;
    label: string;
  }>(`SELECT id, path, slug, label FROM folders ORDER BY created_at ASC`);
  return rows.map((row) => ({
    id: toObjectId(row.id),
    path: row.path,
    slug: row.slug,
    label: row.label,
  }));
}

/**
 * Every slug already in use, for minting a unique one.
 *
 * The registration route reads this once and then dedupes in memory across its
 * retries — re-reading after a collision would keep returning the same
 * pre-collision snapshot until the competing insert committed, so the retry
 * would recompute the same losing slug and burn every attempt.
 */
export async function listFolderSlugs(dbOverride?: SqliteDb): Promise<string[]> {
  const rows = await sqliteDb(dbOverride).read<{ slug: string }>(`SELECT slug FROM folders`);
  return rows.map((row) => row.slug);
}

/**
 * Register a library root and return its new id.
 *
 * Named for what it does rather than for the statement it issues, which also
 * keeps it distinct from the test harness's `insertFolder` fixture — two
 * exports of one name in the same tree resolve ambiguously through a barrel.
 *
 * Throws on a duplicate `path` or `slug`, which is the uniqueness the schema
 * enforces and the registration route recovers from — see
 * {@link isSlugConflict}.
 */
export async function registerFolder(
  input: { path: string; label: string; slug: string; createdAt?: string },
  dbOverride?: SqliteDb,
): Promise<ObjectId> {
  const id = newObjectIdHex();
  await sqliteDb(dbOverride).write(
    `INSERT INTO folders (id, path, slug, label, last_scan, file_count, created_at)
     VALUES (?, ?, ?, ?, NULL, 0, ?)`,
    [id, input.path, input.slug, input.label, input.createdAt ?? nowIso()],
  );
  return toObjectId(id);
}

/**
 * Whether a failed insert failed because another request claimed the slug.
 *
 * The registration route retries on exactly this and rethrows anything else,
 * so the discrimination has to be precise. On Mongo it read `code === 11000`
 * and `keyPattern.slug`; SQLite names the constraint in the message, and
 * naming the column is what keeps a duplicate `path` — a genuine "already
 * registered" answer — from being retried as if it were a slug collision.
 */
export function isSlugConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed:\s*folders\.slug/i.test(message);
}

/** Stamp the completion time of a full scan. */
export async function setFolderLastScan(
  id: ObjectId,
  scannedAt: string,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(`UPDATE folders SET last_scan = ? WHERE id = ?`, [
    scannedAt,
    toHex(id),
  ]);
}

/**
 * Replace a library's mirror roots.
 *
 * Written whole rather than merged: the settings page sends the complete list
 * every time, and a disabled mirror stays in it so the operator can pause a
 * mirror whose disk is offline without losing its configuration.
 */
export async function setFolderMirrors(
  id: ObjectId,
  mirrors: readonly MirrorLocation[],
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(`UPDATE folders SET mirrors = ? WHERE id = ?`, [
    JSON.stringify(mirrors),
    toHex(id),
  ]);
}

/**
 * Libraries that have at least one mirror configured, for rebuilding the
 * in-memory mirror registry at boot and after every edit.
 *
 * The `json_array_length` test is the row-shaped version of Mongo's
 * `{ 'mirrors.0': { $exists: true } }`: it skips both an unset column and an
 * empty list, so a library whose last mirror was removed drops out rather than
 * contributing an empty entry.
 */
export async function listFoldersWithMirrors(
  dbOverride?: SqliteDb,
): Promise<Array<{ path: string; mirrors: MirrorLocation[] }>> {
  const rows = await sqliteDb(dbOverride).read<{ path: string; mirrors: string }>(
    `SELECT path, mirrors FROM folders
      WHERE mirrors IS NOT NULL AND json_array_length(mirrors) > 0`,
  );
  return rows.map((row) => ({
    path: row.path,
    mirrors: parseJson<MirrorLocation[]>(row.mirrors, []),
  }));
}

// ---------------------------------------------------------------------------
// The folder-path cache
// ---------------------------------------------------------------------------

/**
 * Folder id → absolute root path, cached for the life of the process.
 *
 * See the module comment for why this has no invalidation and why that is safe
 * here in a way it was not where it used to live. A miss is not cached: a
 * lookup for an id that does not exist yet must not poison the entry for the
 * library that is about to be registered under it.
 */
const folderPathCache = new Map<string, string>();

/**
 * The absolute root path of a library, or `null` when there is no such row.
 *
 * The change feed calls this on every emit, to turn an asset's absolute path
 * into one relative to its library so File Provider clients can invalidate a
 * single folder instead of their whole working set.
 */
export async function folderPath(id: ObjectId, dbOverride?: SqliteDb): Promise<string | null> {
  const key = toHex(id);
  const hit = folderPathCache.get(key);
  if (hit !== undefined) return hit;
  const rows = await sqliteDb(dbOverride).read<{ path: string }>(
    `SELECT path FROM folders WHERE id = ?`,
    [key],
  );
  const path = rows[0]?.path;
  if (path === undefined) return null;
  folderPathCache.set(key, path);
  return path;
}

/**
 * Drop the cache. For tests, which create and destroy libraries far more often
 * than a running server does — and each with its own database, so one test's
 * entry would otherwise answer another's lookup.
 */
export function __resetFolderPathCacheForTests(): void {
  folderPathCache.clear();
}
