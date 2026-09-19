/**
 * Fixtures for the `/api/assets` and `/api/folders/:id/upload` route suites,
 * against SQLite (#3787).
 *
 * These suites used to insert whole MongoDB documents — a `fileinfo[]` array
 * inline on the asset, a `stages` subdocument, an `enrichment` subdocument —
 * and then assert by reading the same document back. None of those shapes
 * exist any more: a location is a row in `asset_locations`, a stage is a row
 * in `stage_state`, the caption and its provenance are columns on
 * `asset_detail`, and the synthesised search text is a row in `asset_search`.
 *
 * So what lives here is the seeding and the reading-back that the shared
 * harness does not already cover. `insertFolder` / `insertAsset` /
 * `insertLocation` (in `db/sqlite/test-sqlite.test-helpers.ts`) and
 * `insertDetail` / `insertEnrichmentState` (in
 * `db/sqlite/repos/assets.test-helpers.ts`) are the building blocks; nothing
 * below re-implements one.
 */

import type { Database } from 'bun:sqlite';
import * as path from 'node:path';
import {
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../src/indexer/libraries.cache.ts';
import type {
  MeilisearchAssetDoc,
  MeilisearchClient,
} from '../../src/enrichment/meilisearch-client.ts';

/**
 * Register one library root and drop the process-wide roots cache onto it.
 *
 * Every route in these suites resolves a location to an absolute path through
 * `libraries.cache.ts`, which memoises the `folders` read for the life of the
 * process — so a suite that seeds a root without invalidating reads the
 * previous suite's libraries and resolves every path to `null`.
 */
export function registerLibrary(db: Database, root: string, slug?: string): string {
  const id = insertFolder(db, { path: root, ...(slug === undefined ? {} : { slug }) });
  invalidateLibraryRoots();
  return id;
}

/** One asset with exactly one location — the shape every route suite here seeds. */
export interface RouteAssetOptions {
  libraryId: string;
  /** Library-relative directory, POSIX-separated. `''` at the library root. */
  path: string;
  filename: string;
  size?: number;
  /** Epoch milliseconds, as the `assets.mtime` column stores it. */
  mtimeMs?: number;
  deletedAt?: string | null;
  originalPath?: string | null;
  mapleId?: string | null;
  sha1Head?: string | null;
  mediaKind?: 'image' | 'video' | 'audio';
}

/** Seed one asset plus its single location, and return its 24-character hex id. */
export function seedRouteAsset(db: Database, opts: RouteAssetOptions): string {
  const id = insertAsset(db, { deletedAt: opts.deletedAt ?? null });
  insertLocation(db, {
    assetId: id,
    libraryId: opts.libraryId,
    path: opts.path,
    filename: opts.filename,
  });
  run(
    db,
    `UPDATE assets
        SET size = ?, mtime = ?, original_path = ?, maple_id = ?, sha1_head = ?, media_kind = ?
      WHERE id = ?`,
    opts.size ?? 3,
    opts.mtimeMs ?? Date.now(),
    opts.originalPath ?? null,
    opts.mapleId ?? null,
    opts.sha1Head ?? null,
    opts.mediaKind ?? 'image',
    id,
  );
  return id;
}

/** The `assets` columns these suites assert on. */
export interface AssetRow {
  id: string;
  size: number;
  mtime: number;
  deleted_at: string | null;
  deleted_reason: string | null;
  original_path: string | null;
  maple_id: string | null;
  sha1_head: string | null;
}

/** One asset row, or `null` when the asset has been purged. */
export function assetRow(db: Database, id: string): AssetRow | null {
  return (db
    .query(
      `SELECT id, size, mtime, deleted_at, deleted_reason, original_path, maple_id, sha1_head
         FROM assets WHERE id = ?`,
    )
    .get(id) ?? null) as AssetRow | null;
}

/** The `asset_locations` rows behind what used to be `doc.fileinfo[]`. */
export interface LocationRow {
  library_id: string;
  path: string;
  filename: string;
  deleted_at: string | null;
  missing_since: string | null;
}

/** One asset's locations, in `fileinfo[]` order. */
export function locationRows(db: Database, id: string): LocationRow[] {
  return db
    .query(
      `SELECT library_id, path, filename, deleted_at, missing_since
         FROM asset_locations WHERE asset_id = ? ORDER BY ordinal`,
    )
    .all(id) as LocationRow[];
}

/**
 * The absolute path the asset's canonical location composes to, under `root`.
 *
 * Stands in for the `doc.fileinfo[0]` reconstruction every one of these suites
 * used to spell out by hand after the `abs_path` column was dropped.
 */
export function primaryAbsPath(db: Database, root: string, id: string): string | null {
  const first = locationRows(db, id)[0];
  return first === undefined ? null : path.join(root, first.path, first.filename);
}

/** Ids of the assets holding a location at one `(library, directory, filename)` address. */
export function assetIdsAtAddress(
  db: Database,
  libraryId: string,
  relDir: string,
  filename: string,
): string[] {
  return (
    db
      .query(
        `SELECT asset_id FROM asset_locations
          WHERE library_id = ? AND path = ? AND filename = ?`,
      )
      .all(libraryId, relDir, filename) as { asset_id: string }[]
  ).map((row) => row.asset_id);
}

/** Ids of every asset carrying a location with this filename in this library. */
export function assetIdsWithFilename(db: Database, libraryId: string, filename: string): string[] {
  return (
    db
      .query(`SELECT asset_id FROM asset_locations WHERE library_id = ? AND filename = ?`)
      .all(libraryId, filename) as { asset_id: string }[]
  ).map((row) => row.asset_id);
}

/** The full `stage_state` row for one stage, or `null`. */
export interface StageStateRow {
  version: number;
  attempts: number;
  dead: number;
  processed_at: string | null;
  last_error: string | null;
}

export function stageStateRow(db: Database, id: string, stage: string): StageStateRow | null {
  return (db
    .query(
      `SELECT version, attempts, dead, processed_at, last_error
         FROM stage_state WHERE asset_id = ? AND stage = ?`,
    )
    .get(id, stage) ?? null) as StageStateRow | null;
}

/** The full `enrichment_state` row for one stage, or `null`. */
export interface EnrichmentStateRow {
  done_at: string | null;
  locked_by: string | null;
  lease_expires_at: string | null;
  attempts: number;
  last_error: string | null;
  version: number | null;
  dead_letter_at: string | null;
}

export function enrichmentStateRow(
  db: Database,
  id: string,
  stage: string,
): EnrichmentStateRow | null {
  return (db
    .query(
      `SELECT done_at, locked_by, lease_expires_at, attempts, last_error, version, dead_letter_at
         FROM enrichment_state WHERE asset_id = ? AND stage = ?`,
    )
    .get(id, stage) ?? null) as EnrichmentStateRow | null;
}

/**
 * The synthesised search text for one asset.
 *
 * `asset_search` holds a row only while the blob is non-empty (the table's own
 * `CHECK`), so "no row" and "the empty blob" are the same state — which is why
 * this returns `''` rather than `null` for a missing row, matching what the
 * Mongo `search_blob` field read back as.
 */
export function searchBlob(db: Database, id: string): string {
  const row = db.query(`SELECT search_blob FROM asset_search WHERE asset_id = ?`).get(id) as {
    search_blob: string;
  } | null;
  return row?.search_blob ?? '';
}

/** A Meilisearch client that records what the route asked it to do. */
export interface CapturingMeili extends MeilisearchClient {
  tombstones: string[];
  upserts: MeilisearchAssetDoc[];
}

export function capturingMeili(): CapturingMeili {
  const tombstones: string[] = [];
  const upserts: MeilisearchAssetDoc[] = [];
  return {
    tombstones,
    upserts,
    isConfigured: () => true,
    semanticConfigured: () => false,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async (doc) => {
      upserts.push(doc);
    },
    upsertOrThrow: async (doc) => {
      upserts.push(doc);
    },
    tombstone: async (id) => {
      tombstones.push(id);
    },
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
}

/**
 * A Meilisearch client whose named verbs throw — the "search is down" fixture
 * both trash suites use to prove the catalogue write survives it.
 */
export function failingMeili(failing: ('upsert' | 'tombstone')[]): MeilisearchClient {
  const boom = async (): Promise<never> => {
    throw new Error('meilisearch unavailable');
  };
  const upsertFails = failing.includes('upsert');
  const tombstoneFails = failing.includes('tombstone');
  return {
    isConfigured: () => true,
    semanticConfigured: () => false,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: upsertFails ? boom : async () => {},
    upsertOrThrow: upsertFails ? boom : async () => {},
    tombstone: tombstoneFails ? boom : async () => {},
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
}
