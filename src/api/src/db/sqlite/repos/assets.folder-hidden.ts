/**
 * The folder-level `.hidden` marker reconciliation's reads and writes — the
 * SQLite port of what `workers/discover/folder-hidden.ts` used to spell as a
 * batched Mongo cursor plus two guarded `updateMany` calls (#3787).
 *
 * A `.hidden` file in a library directory hides every photo in that directory
 * and its subtree; removing it un-hides exactly the assets it hid. The sweep
 * runs this once per directory per generation, which is what makes the marker a
 * live signal rather than an ingest-time-only one — and which is why both
 * queries below have to match nothing in the steady state, or every sweep would
 * be a write storm over an unchanged library.
 *
 * ## The guard is repeated in the write, deliberately
 *
 * Each `UPDATE` restates the predicates its candidate query used, not just the
 * id list. A concurrent writer — most plausibly the sidecar projection landing a
 * manual override — may have changed the asset between the read and the write,
 * and repeating the predicates turns a stale flip into a no-op instead of
 * stomping the newer state.
 *
 * ## Pagination is keyset, and that is not a micro-optimisation
 *
 * The Mongo version drained a cursor in batches of a thousand, relying on each
 * batch's write to remove those rows from the candidate set. The un-hide pass
 * breaks that assumption: an asset whose other live location still sits under a
 * marked directory is deliberately left hidden, so it stays a candidate, and a
 * plain `LIMIT` loop would hand back the same thousand rows forever. Paging by
 * `id > last` terminates whether or not the write changed anything.
 */

import type { ObjectId } from 'mongodb';
import type { FileInfo } from '../../schema.ts';
import { stageRearmBatchStatement } from './assets.stage-rearm.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { placeholders, toBool, toHex, toObjectId } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

/**
 * One asset the reconcile pass is considering.
 *
 * `locations` carries every location, live or not, because two callers need
 * different parts of it: the R2 thumbnail cleanup resolves the asset's
 * canonical live entry from it, and the un-hide coverage check walks the
 * *other* live entries to see whether any of them still sits under a marked
 * directory. `cfThumbSyncedAt` rides along on the same read for the cleanup.
 */
export interface FolderHiddenCandidate {
  id: ObjectId;
  cfThumbSyncedAt: string | null;
  locations: FileInfo[];
}

/**
 * Live in the sense the marker cares about: a trashed or missing path must
 * neither apply nor lift the folder-hidden state on an otherwise-live asset.
 */
const LIVE_IN_DIR = `
  EXISTS (SELECT 1 FROM asset_locations l
           WHERE l.asset_id = a.id AND l.library_id = ? AND l.path = ?
             AND l.deleted_at IS NULL AND l.missing_since IS NULL)`;

/**
 * An explicit per-photo XMP override wins in both directions — an
 * override-visible asset is never folder-hidden, an override-hidden asset is
 * never folder-un-hidden. `COALESCE` is what makes an asset with no override at
 * all fall through: the Mongo `$ne` matched a missing key, and a missing key is
 * a NULL `json_extract` here.
 */
const OVERRIDE_NOT_VISIBLE = `
  COALESCE((SELECT json_extract(d.metadata_override, '$.hidden')
              FROM asset_detail d WHERE d.asset_id = a.id), 1) <> 0`;

const OVERRIDE_NOT_HIDDEN = `
  COALESCE((SELECT json_extract(d.metadata_override, '$.hidden')
              FROM asset_detail d WHERE d.asset_id = a.id), 0) <> 1`;

const HIDE_PREDICATE = `a.deleted_at IS NULL AND a.hidden = 0
  AND ${LIVE_IN_DIR} AND ${OVERRIDE_NOT_VISIBLE}`;

const UNHIDE_PREDICATE = `a.deleted_at IS NULL AND a.hidden_reason = 'folder'
  AND ${LIVE_IN_DIR} AND ${OVERRIDE_NOT_HIDDEN}`;

/** The stage the hidden flag invalidates: it is a Meilisearch filter value. */
const HIDE_REARM = ['meili'] as const;

/**
 * Un-hiding also re-arms the R2 mirror. Its `{ skip: 'hidden' }` marked itself
 * done, so without the reset an un-hidden asset would never re-mirror — the
 * same rationale as the un-hide path in `sidecar-metadata-index`.
 */
const UNHIDE_REARM = ['meili', 'cf-thumb-sync'] as const;

async function loadCandidates(
  db: SqliteDb,
  predicate: string,
  libraryId: ObjectId,
  path: string,
  after: string,
  limit: number,
): Promise<FolderHiddenCandidate[]> {
  const rows = await db.read<{ id: string; cf_thumb_synced_at: string | null }>(
    `SELECT a.id, a.cf_thumb_synced_at FROM assets a
      WHERE ${predicate} AND a.id > ?
      ORDER BY a.id LIMIT ?`,
    [toHex(libraryId), path, after, limit],
  );
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const locations = await db.read<{
    asset_id: string;
    library_id: string;
    path: string;
    filename: string;
    deleted_at: string | null;
    missing_since: string | null;
    missing_reason: string | null;
    keep: number;
  }>(
    `SELECT asset_id, library_id, path, filename, deleted_at, missing_since, missing_reason, keep
       FROM asset_locations WHERE asset_id IN (${placeholders(ids.length)})
      ORDER BY asset_id, ordinal`,
    ids,
  );
  const byAsset = new Map<string, FileInfo[]>();
  for (const row of locations) {
    const list = byAsset.get(row.asset_id) ?? [];
    list.push({
      library_id: toObjectId(row.library_id),
      path: row.path,
      filename: row.filename,
      deleted_at: row.deleted_at,
      missing_since: row.missing_since,
      missing_reason: row.missing_reason,
      keep: toBool(row.keep),
    });
    byAsset.set(row.asset_id, list);
  }
  return rows.map((row) => ({
    id: toObjectId(row.id),
    cfThumbSyncedAt: row.cf_thumb_synced_at,
    locations: byAsset.get(row.id) ?? [],
  }));
}

/** Visible assets in this directory that the marker should now hide. */
export function listFolderHideCandidates(
  libraryId: ObjectId,
  path: string,
  after: string,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<FolderHiddenCandidate[]> {
  return loadCandidates(sqliteDb(dbOverride), HIDE_PREDICATE, libraryId, path, after, limit);
}

/**
 * Folder-hidden assets in this directory whose marker has gone.
 *
 * Only `hidden_reason = 'folder'` rows are candidates: a manual hide and a
 * nudity hide are untouched by marker removal.
 */
export function listFolderUnhideCandidates(
  libraryId: ObjectId,
  path: string,
  after: string,
  limit: number,
  dbOverride?: SqliteDb,
): Promise<FolderHiddenCandidate[]> {
  return loadCandidates(sqliteDb(dbOverride), UNHIDE_PREDICATE, libraryId, path, after, limit);
}

async function applyVisibility(
  db: SqliteDb,
  ids: readonly ObjectId[],
  assignment: string,
  predicate: string,
  libraryId: ObjectId,
  path: string,
  stages: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const hexes = ids.map(toHex);
  const results = await db.transaction([
    {
      sql: `UPDATE assets AS a SET ${assignment}
             WHERE a.id IN (${placeholders(hexes.length)}) AND ${predicate}`,
      params: [...hexes, toHex(libraryId), path],
    },
    ...stages.map((stage) => stageRearmBatchStatement(hexes, stage)),
  ]);
  return results[0]?.changes ?? 0;
}

/**
 * Hide the named assets, and re-arm the search index for them.
 *
 * Folder hides are operator-initiated — the operator created the file — so
 * `hidden_ack` is deliberately not set and the assets stay out of the AI-review
 * list, the same as a manual hide.
 */
export function hideAssetsInFolder(
  ids: readonly ObjectId[],
  libraryId: ObjectId,
  path: string,
  dbOverride?: SqliteDb,
): Promise<number> {
  return applyVisibility(
    sqliteDb(dbOverride),
    ids,
    `hidden = 1, hidden_reason = 'folder'`,
    HIDE_PREDICATE,
    libraryId,
    path,
    HIDE_REARM,
  );
}

/** Un-hide the named assets, and re-arm search plus the R2 mirror. */
export function unhideAssetsInFolder(
  ids: readonly ObjectId[],
  libraryId: ObjectId,
  path: string,
  dbOverride?: SqliteDb,
): Promise<number> {
  return applyVisibility(
    sqliteDb(dbOverride),
    ids,
    `hidden = 0, hidden_reason = NULL`,
    UNHIDE_PREDICATE,
    libraryId,
    path,
    UNHIDE_REARM,
  );
}
