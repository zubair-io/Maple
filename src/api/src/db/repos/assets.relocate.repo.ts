/**
 * The writes an in-app relocate performs, plus the one read it has to do first
 * (#3787).
 *
 * `library/relocate-asset.ts` is the orchestrator every file-management feature
 * is built on — rename, move, drag-to-folder, batch rename — and it wires this
 * module's {@link repointAssetLocation} as the hook `fs/relocate.ts` runs
 * strictly between a verified copy and the delete of the original. That
 * ordering is the failure-direction contract: any failure up to and including a
 * failed repoint leaves the original completely untouched.
 *
 * Kept apart from `assets.locations.repo.ts`, which is the read side of the
 * same two tables, because these three statements are the ones with a
 * concurrency argument attached and a reviewer should be able to read them
 * together.
 */

import type { ObjectId } from '../object-id.ts';
import type { SqlStatement } from '../sqlite/protocol.ts';
import { meiliRearmStatement, relocateCacheRearmStatements } from './assets.stage-rearm.ts';
import { changesAt, sqliteDb, type SqliteDb } from './db-handle.ts';
import { toHex, toObjectId } from './values.ts';

/** A location's address: the library that owns it and its place inside it. */
export interface LocationAddress {
  libraryId: ObjectId;
  path: string;
  filename: string;
}

/**
 * The live, indexed asset — other than `excludeId` — that already occupies this
 * address, or `null` when nothing tracked is there.
 *
 * Only `collision: 'replace'` asks. The filesystem primitive is deliberately
 * catalogue-unaware and will publish over whatever sits at the destination, and
 * (when the incoming asset has no sidecar) unlink whatever `.xmp` sits beside
 * it. That is fine over an untracked file — an ordinary file the indexer has not
 * catalogued, or nothing at all — and is silent data loss over a tracked one:
 * the occupant's row is left pointing at someone else's pixels.
 *
 * "Live" means both halves, as it did on Mongo. The location is not tagged
 * `deleted_at`, so it is the entry that currently names this path; and the
 * asset's own `deleted_at` is unset. The second test is defence in depth — a
 * trashed asset's entry is repointed at the trash copy and so cannot ordinarily
 * collide with a real destination — and it is what makes the answer match the
 * "a live asset occupies it" question the caller is really asking.
 */
export async function findLiveOccupantAssetId(
  address: LocationAddress,
  excludeId: ObjectId,
  dbOverride?: SqliteDb,
): Promise<string | null> {
  const rows = await sqliteDb(dbOverride).read<{ asset_id: string }>(
    `SELECT l.asset_id
       FROM asset_locations l
       JOIN assets a ON a.id = l.asset_id
      WHERE l.library_id = ? AND l.path = ? AND l.filename = ?
        AND l.deleted_at IS NULL
        AND a.deleted_at IS NULL
        AND l.asset_id <> ?
      LIMIT 1`,
    [toHex(address.libraryId), address.path, address.filename, toHex(excludeId)],
  );
  return rows[0]?.asset_id ?? null;
}

/**
 * Move one location to a new address and invalidate what the move invalidated.
 *
 * The `from` address is part of the `WHERE`, not just the asset id, and that is
 * the concurrent-mutation guard: a row count of zero means the entry changed
 * out from under the caller between reading it and writing it, which is the
 * signal `relocateAsset` turns into an abort *before* the original file is
 * deleted. Filtering on the id alone would match, write nothing useful, and
 * report success.
 *
 * `missing_since` is cleared because the file is demonstrably there — the
 * primitive verified the copy before calling this. `missing_reason` goes with
 * it: keeping a reason for a tag that is no longer set is how a stale
 * explanation outlives the condition it described.
 *
 * The three re-arms are the same ones trash uses, for the same reason. `meili`
 * rebuilds the search document; `thumb` and `preview` are keyed on the file's
 * path, so without the reset the row keeps claiming a thumbnail at a path the
 * file no longer occupies (`docs/caching.md`). The expensive per-image stages
 * are deliberately untouched: the pixels did not change.
 *
 * `appleRenderedPath` is written only when the caller supplies one. A PhotoKit
 * companion that was requested but failed its best-effort copy leaves the
 * caller with nothing to pass, and the stored value must then stay exactly as
 * it was rather than be cleared.
 *
 * Returns whether the entry was found and moved — a boolean rather than a row
 * count, and that is not cosmetic. Clearing `missing_since` fires the
 * `asset_locations_count_au` trigger, which issues two further `UPDATE assets`
 * statements, and `bun:sqlite` counts every row a statement touched including a
 * trigger's. So this write reports three changed rows for one moved location,
 * and a caller comparing against 1 would abort a relocate that had in fact
 * succeeded. Zero is still unambiguous: no row matched, so no trigger ran.
 */
export async function repointAssetLocation(
  args: {
    id: ObjectId;
    from: LocationAddress;
    to: LocationAddress;
    appleRenderedPath?: string;
  },
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const hex = toHex(args.id);
  const companion: SqlStatement[] =
    args.appleRenderedPath === undefined
      ? []
      : [
          {
            sql: `UPDATE assets SET apple_rendered_path = ? WHERE id = ?`,
            params: [args.appleRenderedPath, hex],
          },
        ];

  const results = await sqliteDb(dbOverride).transaction([
    {
      // Free the destination address of any DEAD claim on it first.
      //
      // `asset_locations_lib_path_name` is UNIQUE over (library_id, path,
      // filename) and is not partial over live rows, so a soft-deleted row
      // still reserves the address it names. The reaper reaches exactly that
      // state: it soft-deletes an asset whose file vanished without repointing
      // the location, so the dead row goes on naming a path that no longer has
      // a file at it. If the file comes back and a user relocates a different
      // asset onto it, the occupancy guard correctly allows the move — the
      // occupant is not live — and then the repoint below collided with the
      // index and surfaced as "fileinfo entry changed concurrently", which is a
      // 500 carrying an untrue explanation for a move that MongoDB completed.
      //
      // Only the location row goes, never the asset: unlike `restoreFromTrash`,
      // whose collision is a watcher-inserted skeleton worth deleting outright,
      // this one is a real asset with history. Its address claim is what is
      // stale, and for a reaped row it is stale by definition — the file it
      // named is gone. A user-trashed asset is unaffected, because
      // `markSoftDeleted` repoints its location into the trash directory, so it
      // never claims an ordinary destination.
      //
      // Scoped to `deleted_at IS NOT NULL`: a LIVE occupant must still collide
      // rather than be quietly evicted, which is what the `occupied` result in
      // `library/relocate-asset.ts` exists to report.
      sql: `DELETE FROM asset_locations
             WHERE library_id = ? AND path = ? AND filename = ?
               AND deleted_at IS NOT NULL
               AND NOT (asset_id = ? AND library_id = ? AND path = ? AND filename = ?)`,
      params: [
        toHex(args.to.libraryId),
        args.to.path,
        args.to.filename,
        hex,
        toHex(args.from.libraryId),
        args.from.path,
        args.from.filename,
      ],
    },
    {
      sql: `UPDATE asset_locations
               SET library_id = ?, path = ?, filename = ?,
                   missing_since = NULL, missing_reason = NULL
             WHERE asset_id = ? AND library_id = ? AND path = ? AND filename = ?
               AND deleted_at IS NULL`,
      params: [
        toHex(args.to.libraryId),
        args.to.path,
        args.to.filename,
        hex,
        toHex(args.from.libraryId),
        args.from.path,
        args.from.filename,
      ],
    },
    ...companion,
    meiliRearmStatement(hex),
    ...relocateCacheRearmStatements(hex),
  ]);
  // Index 1, not 0 — the dead-claim DELETE above is the batch's first
  // statement and reports its own row count, which is 0 on the ordinary path.
  return changesAt(results, 1) > 0;
}

/**
 * Mark the asset at this address as having an edited sidecar, and return which
 * asset that was.
 *
 * The batch settings-sync publisher resolves the selected copy and bumps its
 * version at publication time rather than earlier, so a relocate that happens
 * mid-batch cannot redirect an earlier lookup to a different file. The write is
 * keyed on the address for exactly that reason — it is the `$elemMatch` filter
 * of the `findOneAndUpdate` it replaces, and `asset_locations_lib_path_name` is
 * UNIQUE, so it can match at most one asset.
 *
 * The id is then read back rather than returned by the write. `UPDATE …
 * RETURNING` would say it in one statement, but the pool's reader connections
 * are opened `readonly` (`db/sqlite/worker-db.ts`) and its writer reports only a
 * row count, so a statement that both mutates and yields rows has nowhere to
 * run. The read is skipped entirely when nothing was bumped.
 *
 * `null` when no live location has that address, which the caller records as a
 * change with no asset attached rather than treating as a failure.
 */
export async function recordSidecarEditAtAddress(
  address: LocationAddress,
  dbOverride?: SqliteDb,
): Promise<ObjectId | null> {
  const db = sqliteDb(dbOverride);
  const params = [toHex(address.libraryId), address.path, address.filename];
  const located = `SELECT asset_id FROM asset_locations
                    WHERE library_id = ? AND path = ? AND filename = ? AND deleted_at IS NULL`;

  const result = await db.write(
    `UPDATE assets SET has_xmp = 1, sidecar_ver = sidecar_ver + 1 WHERE id IN (${located})`,
    params,
  );
  if (result.changes === 0) return null;

  const rows = await db.read<{ asset_id: string }>(located, params);
  const id = rows[0]?.asset_id;
  return id === undefined ? null : toObjectId(id);
}
