/**
 * The persisted RAW+JPEG pairing (#5849): `assets.stack_primary_id` on a JPEG
 * names the same-stem RAW beside it, so search and the timeline fold the pair
 * with an indexed residual instead of a stem match per row.
 *
 * The discover sweep reconciles one folder per visit, because a pairing is a
 * property of a folder's set of files rather than of one file's bytes: a JPEG
 * pairs or unpairs when a sibling appears or goes. Migration 0044's triggers
 * unpair the moment either half is trashed, moved or goes missing, so the
 * sweep is only ever late to pair, never late to unpair.
 */

import { child as childLogger } from '../../log.ts';
import type { ObjectId } from '../object-id.ts';
import { pairStackAssets, type StackFile } from '../../library/raw-jpeg-stack.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { placeholders } from './values.ts';
import type { SqlStatement } from '../sqlite/protocol.ts';

const log = childLogger('db/repos/assets.raw-jpeg-stacks');

interface FolderFile extends StackFile {
  stack_primary_id: string | null;
}

/** A file that is still where the read found it: live, canonical and not trashed. */
const STILL_IN_FOLDER = `EXISTS (SELECT 1 FROM asset_locations l JOIN assets a ON a.id = l.asset_id
   WHERE l.asset_id = ? AND l.library_id = ? AND l.path = ? AND l.ordinal = 0
     AND l.deleted_at IS NULL AND l.missing_since IS NULL AND a.deleted_at IS NULL)`;

function pairStatement(
  file: FolderFile,
  primary: string | null,
  library: string,
  relPath: string,
): SqlStatement {
  if (primary === null) {
    return {
      sql: 'UPDATE assets SET stack_primary_id = NULL WHERE id = ?',
      params: [file.asset_id],
    };
  }
  return {
    sql: `UPDATE assets SET stack_primary_id = ?
           WHERE id = ? AND ${STILL_IN_FOLDER} AND ${STILL_IN_FOLDER}`,
    params: [primary, file.asset_id, file.asset_id, library, relPath, primary, library, relPath],
  };
}

/** Brings one folder's pairings in line with its files; writes only what changed. */
export async function reconcileRawJpegStacks(
  libraryId: ObjectId,
  relPath: string,
  dbOverride?: SqliteDb,
): Promise<number> {
  const db = sqliteDb(dbOverride);
  const library = libraryId.toHexString();
  const files = await db.read<FolderFile>(
    `SELECT l.asset_id AS asset_id, l.filename AS filename, a.stack_primary_id AS stack_primary_id
       FROM asset_locations l INDEXED BY asset_locations_lib_path_name
       JOIN assets a ON a.id = l.asset_id
      WHERE l.library_id = ? AND l.path = ? AND l.ordinal = 0
        AND l.deleted_at IS NULL AND l.missing_since IS NULL AND a.deleted_at IS NULL`,
    [library, relPath],
  );
  const pairs = pairStackAssets(files);
  const changes = files.flatMap((file) => {
    const primary = pairs.get(file.asset_id) ?? null;
    return primary === file.stack_primary_id
      ? []
      : [pairStatement(file, primary, library, relPath)];
  });
  if (changes.length > 0) await db.transaction(changes);
  return changes.length;
}

/** A folder an in-app move, rename or restore just wrote to or out of. */
export interface StackFolder {
  libraryId: ObjectId;
  relPath: string;
}

/**
 * Re-pairs the folders an in-app move, rename or restore just changed. The triggers unpair a half
 * the moment its location changes, and clients move a stack as two per-asset calls, so without
 * this the pair shows as two tiles until the sweep next visits the folder. It never fails the
 * file operation that has already committed: the sweep stays the backstop.
 */
export async function reconcileStacksAfterMove(folders: readonly StackFolder[]): Promise<void> {
  const distinct = new Map(
    folders.map((folder) => [`${folder.libraryId.toHexString()}:${folder.relPath}`, folder]),
  );
  for (const { libraryId, relPath } of distinct.values()) {
    await reconcileRawJpegStacks(libraryId, relPath).catch((error: unknown) =>
      log.warn(
        { libraryId: libraryId.toHexString(), relPath, error: String(error) },
        'RAW+JPEG stack reconcile after a move failed; the sweep will pair it',
      ),
    );
  }
}

/** The JPEG folded into a RAW, as a search result lists it beside the RAW. */
export interface StackCompanionRow {
  id: string;
  primary_id: string;
  library_id: string;
  path: string;
  filename: string;
  size: number;
  mtime: number;
}

/** The live companions of `primaryIds`, through the partial index on the pointer. */
export async function stackCompanionsOf(
  primaryIds: readonly string[],
  dbOverride?: SqliteDb,
): Promise<StackCompanionRow[]> {
  if (primaryIds.length === 0) return [];
  return sqliteDb(dbOverride).read<StackCompanionRow>(
    `SELECT a.id AS id, a.stack_primary_id AS primary_id, l.library_id AS library_id,
            l.path AS path, l.filename AS filename, a.size AS size, a.mtime AS mtime
       FROM assets a INDEXED BY assets_stack_primary
       JOIN asset_locations l ON l.asset_id = a.id AND l.ordinal = 0
      WHERE a.stack_primary_id IN (${placeholders(primaryIds.length)})
        AND a.deleted_at IS NULL AND a.live_location_count > 0`,
    [...primaryIds],
  );
}
