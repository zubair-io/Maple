/**
 * Fixtures for the Meilisearch backfill suites: one indexable asset, and the
 * dead letters that reference it.
 *
 * Shared by `meilisearch-backfill-redrive.test.ts`,
 * `meilisearch-backfill-resilience.test.ts` and
 * `meilisearch-backfill-shape-generation.test.ts`, which all need the same
 * thing — an asset with a content-dedup id, one live location and some text to
 * index — and which used to each spell it out as a Mongo document literal.
 */

import type { Database } from 'bun:sqlite';
import { newObjectIdHex } from '../../src/db/object-id.ts';
import { insertDetail } from '../../src/db/repos/assets.test-helpers.ts';
import { insertFolder, insertLocation, run } from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

/**
 * One library for the whole suite, created lazily.
 *
 * `asset_locations.library_id` is a real foreign key, so every location needs a
 * folder row — and a suite that made one per asset would say something about
 * libraries it does not mean.
 */
function libraryFor(db: Database): string {
  const rows = db.query(`SELECT id FROM folders LIMIT 1`).all() as Array<{ id: string }>;
  return rows[0]?.id ?? insertFolder(db, { path: '/library' });
}

export interface SeedAssetOptions {
  /** Defaults to a fresh hex id; pass one to control the cursor order. */
  id?: string;
  /** The content-dedup id. `null` makes the asset unindexable. */
  mapleId?: string | null;
  /** The caption the search blob is composed from. */
  description?: string;
  /** Set to soft-delete the asset, which makes the pass tombstone it. */
  deletedAt?: string | null;
  /** Set to make the asset's only location non-live. */
  missingSince?: string | null;
  /** Writes a `place` whose denormalised blob is this value. See {@link BROKEN_PLACE}. */
  placeSearchBlob?: unknown;
}

/**
 * A `place` whose denormalised search blob is a number rather than a string.
 *
 * This is how the suites reproduce the compose failure the redrive pass exists
 * for. `composeSearchBlob` calls `toLowerCase()` on every source it is handed,
 * so a numeric blob throws a `TypeError` — the shape of a genuinely bad-data
 * row, reproducible on every attempt until somebody rewrites the column.
 *
 * It has to be the `place` JSON rather than the caption, because `description`
 * is a TEXT column: SQLite's type affinity would quietly store a bound `42` as
 * `'42'` and the composer would be perfectly happy with it.
 */
export const BROKEN_PLACE = 42;

/** An indexable asset with one live location. */
export function seedIndexableAsset(db: Database, options: SeedAssetOptions = {}): string {
  const id = options.id ?? newObjectIdHex();
  const mapleId = options.mapleId === undefined ? `maple-${id}` : options.mapleId;
  const place =
    options.placeSearchBlob === undefined
      ? null
      : JSON.stringify({ search_blob: options.placeSearchBlob });
  run(
    db,
    `INSERT INTO assets (id, size, mtime, indexed_at, maple_id, deleted_at, place)
     VALUES (?, 1, 1, ?, ?, ?, ?)`,
    id,
    '2026-01-01T00:00:00.000Z',
    mapleId,
    options.deletedAt ?? null,
    place,
  );
  insertLocation(db, {
    assetId: id,
    libraryId: libraryFor(db),
    path: '',
    filename: `${mapleId ?? id}.jpg`,
    missingSince: options.missingSince ?? null,
  });
  insertDetail(db, id, { description: options.description ?? 'a caption worth indexing' });
  return id;
}

/** Rewrite an asset's place blob, as a later geocode pass would. */
export function repairPlace(db: Database, assetId: string): void {
  run(db, `UPDATE assets SET place = ? WHERE id = ?`, '{"search_blob":"albany"}', assetId);
}

/** Park a dead letter for an asset, as a failed compose or write would. */
export function seedFailure(
  db: Database,
  args: { assetId: string; mapleId: string; attempts?: number; updatedAt?: string },
): void {
  run(
    db,
    `INSERT INTO meilisearch_backfill_failures (asset_id, maple_id, error, attempts, updated_at)
     VALUES (?, ?, 'boom', ?, ?)`,
    args.assetId,
    args.mapleId,
    args.attempts ?? 1,
    args.updatedAt ?? new Date(0).toISOString(),
  );
}

/** The parked rows, keyed by the `maple_id` the suites name them with. */
export function failuresByMapleId(db: Database): Map<string, { attempts: number }> {
  const rows = db
    .query(`SELECT maple_id, attempts FROM meilisearch_backfill_failures`)
    .all() as Array<{ maple_id: string; attempts: number }>;
  return new Map(rows.map((row) => [row.maple_id, { attempts: row.attempts }]));
}
