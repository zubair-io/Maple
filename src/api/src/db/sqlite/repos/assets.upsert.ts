/**
 * The indexer's skeleton upsert — the SQLite port of
 * `indexer/images.repo.ts`'s `upsertByMapleId` (#3787).
 *
 * Phase 1 of `docs/indexer-enrichment.md` §1.1: identify a file by its
 * content-derived `maple_id`, create the asset if it is new, and refresh the
 * fast-tier stat fields if it is not. Everything an enrichment worker owns is
 * seeded once and never touched again, so a re-upsert after an mtime change
 * cannot clobber what a worker has already written.
 *
 * ## Most of `$setOnInsert` has no equivalent, and that is the point
 *
 * The Mongo version seeds eleven fields on insert — `rating`, `flag`,
 * `color_label`, `live_location_count`, `enrichment`, `place`, `faces`,
 * `description`, `ai_tags` and the `fileinfo` entry — because a document has no
 * shape until somebody writes one. Here:
 *
 *  - `rating`, `flag` and `color_label` are `NOT NULL DEFAULT` columns.
 *  - `live_location_count` is derived by the triggers on `asset_locations`
 *    (`db/sqlite/ddl/asset-locations.ts`), so writing it would be writing a
 *    value the database is about to overwrite anyway.
 *  - `place` is a nullable column; `faces`, `description` and the enrichment
 *    bookkeeping are rows in their own tables, and every reader already treats
 *    an absent row as "never written" — the same thing a missing subdocument
 *    meant. `ai_tags` has no column at all: it is a retired AI-stage output
 *    that Phase 1 stopped writing long before this port.
 *
 * What is left is the asset row and its first location.
 */

import type { ObjectId } from '../../object-id.ts';
import type { SqlValue } from '../protocol.ts';
import type { AssetExif } from '../../schema.ts';
import { newObjectIdHex } from '../../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toObjectId } from './values.ts';

export interface UpsertAssetInput {
  libraryId: ObjectId;
  /** POSIX-style relative directory under the library root. `''` for the root. */
  relDir: string;
  filename: string;
  size: number;
  mtime: number;
  mapleId: string;
  sha1Head: string;
  /**
   * EXIF extraction result. `undefined` means the caller did not run exif and
   * the stored value must not be written or cleared. `null` means exif ran and
   * produced nothing usable, which is a value worth storing — the search route
   * distinguishes "not yet processed" from "no metadata available".
   */
  exif?: AssetExif | null;
}

/**
 * The conflict target has to name the partial index's own `WHERE`.
 *
 * `assets_maple_id` is UNIQUE over `maple_id IS NOT NULL`, and SQLite matches an
 * upsert's conflict target against a partial index only when the target repeats
 * that predicate. Without it the statement fails to prepare rather than
 * silently taking the insert branch, which is the failure worth having.
 */
const CONFLICT_TARGET = `ON CONFLICT (maple_id) WHERE maple_id IS NOT NULL DO UPDATE SET`;

/**
 * Two statement texts rather than one, chosen by whether the caller ran exif.
 *
 * `exif = excluded.exif` would clear a stored payload whenever the caller
 * passed nothing, which is exactly the clobber the Mongo version avoids by
 * leaving the key out of its `$set`. Omitting the assignment is the same
 * refusal, and the alternative — `COALESCE(excluded.exif, exif)` — would make
 * an explicit `null` indistinguishable from an absent one.
 */
function upsertAssetSql(writeExif: boolean): string {
  return `
    INSERT INTO assets (id, size, mtime, indexed_at, deleted_at, maple_id, sha1_head, exif)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    ${CONFLICT_TARGET}
      size = excluded.size,
      mtime = excluded.mtime,
      sha1_head = excluded.sha1_head,
      indexed_at = excluded.indexed_at,
      deleted_at = NULL${writeExif ? ',\n      exif = excluded.exif' : ''}`;
}

/**
 * Seed the asset's canonical location, and only when it has none.
 *
 * Sourced from `assets` so the id it writes is whichever row the upsert above
 * settled on — the freshly inserted one, or the existing one the `maple_id`
 * matched. `ON CONFLICT DO NOTHING` covers both uniqueness constraints that can
 * refuse it: the asset already has an `ordinal = 0` entry, or some asset
 * already claims this exact `(library, directory, filename)`. Both mean the
 * location is already recorded, which is what `$setOnInsert: { fileinfo }`
 * meant — the discover watcher owns the array from then on.
 */
const INSERT_PRIMARY_LOCATION_SQL = `
  INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename, deleted_at)
  SELECT id, 0, ?, ?, ?, NULL FROM assets WHERE maple_id = ?
  ON CONFLICT DO NOTHING`;

/**
 * Upsert one asset by its content identity and return the row's id.
 *
 * The id is returned because the caller needs it and the alternative is a
 * second query: the Mongo version leaves the caller to re-read the document by
 * `maple_id` to discover what was written, which is one more round trip and one
 * more chance for a concurrent write to answer a different asset.
 *
 * Both statements are one transaction, so an asset can never be visible without
 * the location that says where its bytes are.
 */
export async function upsertAssetByMapleId(
  input: UpsertAssetInput,
  now: () => Date = () => new Date(),
  dbOverride?: SqliteDb,
): Promise<{ id: ObjectId }> {
  const db = sqliteDb(dbOverride);
  const writeExif = input.exif !== undefined;
  const assetParams: SqlValue[] = [
    newObjectIdHex(),
    input.size,
    input.mtime,
    now().toISOString(),
    input.mapleId,
    input.sha1Head,
    input.exif === undefined || input.exif === null ? null : JSON.stringify(input.exif),
  ];

  await db.transaction([
    { sql: upsertAssetSql(writeExif), params: assetParams },
    {
      sql: INSERT_PRIMARY_LOCATION_SQL,
      params: [input.libraryId.toHexString(), input.relDir, input.filename, input.mapleId],
    },
  ]);

  const rows = await db.read<{ id: string }>(`SELECT id FROM assets WHERE maple_id = ?`, [
    input.mapleId,
  ]);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`upsertAssetByMapleId: no asset for ${input.mapleId}`);
  return { id: toObjectId(id) };
}
