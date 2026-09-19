/**
 * Shared fixtures for the four `/api/library/relocate` suites.
 *
 * All four drive the mounted route handler against a real temp library on disk
 * and a real SQLite database (#3787) — the wiring suite plus three end-to-end
 * ones, split by subject: the general case, the video full-name sidecar
 * convention, and the Apple-rendered companion with the byte-identical dedupe.
 * They previously shared a copy-pasted `seedLibrary`/`usPlaceText`/`postX` block
 * each and a throwaway Mongo database; the seed is more involved now — an asset
 * is a row plus a location plus a detail row plus its stage bookkeeping — so it
 * lives here once.
 *
 * Nothing skips. The database is created per test, in memory, so there is no
 * external service to be unreachable and no "the suite was green because it did
 * not run" reading of a pass.
 */

import type { Database } from 'bun:sqlite';
import { Elysia } from 'elysia';
import { ObjectId } from '../db/object-id.ts';
import { run } from '../db/sqlite/test-sqlite.test-helpers.ts';
import {
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { insertStageState } from '../db/repos/assets.test-helpers.ts';
import { setLibraryBySlugForTests, setLibraryRootsForTests } from '../indexer/libraries.cache.ts';
import {
  SIDECAR_METADATA_INDEX_STAGE_NAME,
  SIDECAR_METADATA_INDEX_VERSION,
} from '../workers/stages/sidecar-metadata-index.ts';
import { libraryRelocateRoutes } from './library-relocate.ts';

export const SLUG = 'photos';

/** The routes mounted on their own, with no auth middleware in front. */
export const app = new Elysia().use(libraryRelocateRoutes);

export async function postCount(addresses: string[]): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/library/relocate-count', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses }),
    }),
  );
}

export async function postRelocate(addresses: string[]): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/library/relocate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses }),
    }),
  );
}

/** Minimal `metadata_override.place_text` so `geoDir` computes California/Berkeley. */
export function usPlaceText(): Record<string, unknown> {
  return {
    edited_at: new Date().toISOString(),
    touched_fields: ['place_text'],
    place_text: {
      city: 'Berkeley',
      state: 'California',
      country: 'United States',
      country_code: 'us',
    },
  };
}

export interface SeedAssetOptions {
  /** The temp directory standing in for the library root. */
  root: string;
  /** The location's directory, relative to the root. */
  relPath: string;
  filename: string;
  /** Content id, which the post-move `.maple` cache reclaim keys off. */
  mapleId: string;
  /** Written into `asset_detail`; omit for an asset that has never been edited. */
  metadataOverride?: Record<string, unknown> | null;
  /** Relative path of the Apple-rendered JPEG companion, if there is one. */
  appleRenderedPath?: string | null;
  capturedYear?: number;
  missingSince?: string | null;
  /**
   * What `sidecar-metadata-index` has recorded for this asset. Defaults to the
   * current target, i.e. "already reconciled"; pass 0 to make the route do the
   * on-the-fly reconcile.
   */
  sidecarStageVersion?: number;
}

export interface SeededAsset {
  /** The asset id as the routes and the repositories hand it around. */
  id: ObjectId;
  /** The same id as the hex string a direct query binds. */
  assetId: string;
  libraryId: string;
}

/**
 * One relocatable asset: the row, its single location, its override document
 * and the stage bookkeeping — with the library-roots cache wired to resolve it
 * by id and by slug.
 *
 * `thumb`, `preview` and `meili` are seeded at version 1 rather than left
 * absent, because a relocate re-arms all three and a test that cannot see them
 * move would not notice if it stopped.
 */
export function seedRelocatableAsset(db: Database, options: SeedAssetOptions): SeededAsset {
  const libraryId = insertFolder(db, { path: options.root, slug: SLUG });
  const assetId = insertAsset(db, {
    exif: JSON.stringify({ captured_year: options.capturedYear ?? 2024 }),
  });
  insertLocation(db, {
    assetId,
    libraryId,
    path: options.relPath,
    filename: options.filename,
    missingSince: options.missingSince ?? null,
  });
  run(
    db,
    `UPDATE assets SET maple_id = ?, apple_rendered_path = ? WHERE id = ?`,
    options.mapleId,
    options.appleRenderedPath ?? null,
    assetId,
  );
  if (options.metadataOverride != null) {
    run(
      db,
      `INSERT INTO asset_detail (asset_id, metadata_override) VALUES (?, json(?))`,
      assetId,
      JSON.stringify(options.metadataOverride),
    );
  }
  insertStageState(db, assetId, SIDECAR_METADATA_INDEX_STAGE_NAME, {
    version: options.sidecarStageVersion ?? SIDECAR_METADATA_INDEX_VERSION,
  });
  for (const stage of ['thumb', 'preview', 'meili']) {
    insertStageState(db, assetId, stage, { version: 1 });
  }

  setLibraryRootsForTests(new Map([[libraryId, options.root]]));
  setLibraryBySlugForTests(SLUG, {
    libraryId: new ObjectId(libraryId),
    root: options.root,
    label: 'Photos',
  });
  return { id: new ObjectId(assetId), assetId, libraryId };
}

/** One asset's live location, as the relocate repointed it. */
export interface LocationRow {
  path: string;
  filename: string;
  missing_since: string | null;
}

export function locationOf(db: Database, assetId: string): LocationRow | null {
  return (db
    .query(
      `SELECT path, filename, missing_since FROM asset_locations
        WHERE asset_id = ? AND deleted_at IS NULL ORDER BY ordinal`,
    )
    .get(assetId) ?? null) as LocationRow | null;
}

/** The stored Apple-rendered companion path, which a move repoints. */
export function appleRenderedPathOf(db: Database, assetId: string): string | null {
  const row = db.query(`SELECT apple_rendered_path AS p FROM assets WHERE id = ?`).get(assetId) as {
    p: string | null;
  } | null;
  return row?.p ?? null;
}

/** The override document the sidecar reconcile wrote, or null. */
export function metadataOverrideOf(db: Database, assetId: string): Record<string, unknown> | null {
  const row = db
    .query(`SELECT metadata_override AS o FROM asset_detail WHERE asset_id = ?`)
    .get(assetId) as { o: string | null } | null;
  return row?.o == null ? null : (JSON.parse(row.o) as Record<string, unknown>);
}

/** One stage's recorded version for an asset; -1 when it has no row at all. */
export function stageVersionOf(db: Database, assetId: string, stage: string): number {
  const row = db
    .query(`SELECT version FROM stage_state WHERE asset_id = ? AND stage = ?`)
    .get(assetId, stage) as { version: number } | null;
  return row?.version ?? -1;
}

/** Reset the library-roots cache to its lazy-load state after a test. */
export function clearLibraryCache(): void {
  setLibraryRootsForTests(null);
}
