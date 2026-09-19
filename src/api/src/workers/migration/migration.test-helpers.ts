/**
 * Shared fixtures for the data-migration suites.
 *
 * Not a test file — the name does not match Bun's `*.test.ts` glob, so it never
 * runs on its own.
 *
 * Every migration here works the same way: select assets matching a predicate
 * that are not yet stamped at the current generation, do something, stamp them.
 * So the fixtures are a database with a registered library, a way to put an
 * asset into whatever state the predicate is supposed to select (or reject),
 * and narrow reads for the columns each migration writes.
 *
 * The file-moving migrations additionally need a real directory tree, because
 * their move is genuinely crash-safe — copy, verify, repoint, delete, reclaim —
 * and none of that can be asserted against a fake filesystem. {@link createLibrary}
 * gives them both halves and cleans up the directory when the block exits.
 */

import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObjectId } from 'mongodb';
import { newObjectIdHex } from '../../db/sqlite/object-id.ts';
import { toObjectId } from '../../db/sqlite/repos/values.ts';
import { createLiveTestDatabase, insertFolder } from '../../db/sqlite/test-sqlite.test-helpers.ts';

/** A registered library rooted at a real temporary directory. */
export interface MigrationLibrary extends Disposable {
  readonly db: Database;
  readonly root: string;
  readonly folderId: ObjectId;
}

export async function createLibrary(prefix = 'maple-migration-'): Promise<MigrationLibrary> {
  const live = await createLiveTestDatabase();
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    const folderId = toObjectId(insertFolder(live.db, { path: root }));
    const close = (): void => {
      try {
        live.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };
    return { db: live.db, root, folderId, [Symbol.dispose]: close };
  } catch (err) {
    live.close();
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

/** Everything a migration's candidate predicate can look at. */
export interface SeedAsset {
  id?: string;
  mapleId?: string | null;
  mediaKind?: 'image' | 'video' | 'audio';
  isScreenshot?: boolean | null;
  place?: object | null;
  exif?: object | null;
  appleRenderedPath?: string | null;
  deletedAt?: string | null;
  /** The describe stage's structured output, which lives in `asset_detail`. */
  vision?: object | null;
  /** Provenance for borrowed GPS, also in `asset_detail`. */
  geoInferred?: object | null;
  /** One PHAsset link per device id — what "came from a mobile backup" means. */
  phassetDevices?: readonly string[];
  backupLayoutVersion?: number | null;
  legacyDaydirVersion?: number | null;
  videoMetaVersion?: number | null;
  videoPosterRearmVersion?: number | null;
  videoScreenshotClearVersion?: number | null;
  previewMissingRedriveVersion?: number | null;
  geoBackfillSkipped?: 'no-donor' | 'skip' | null;
  /** Stage rows to seed. A migration that re-arms a stage needs one to exist. */
  stages?: readonly string[];
  /** One location, since almost every predicate needs the asset to have one. */
  location?: { libraryId: ObjectId; path?: string; filename: string; missingSince?: string | null };
}

/** Insert one asset in the state a migration's predicate is meant to judge. */
export function seedAsset(db: Database, asset: SeedAsset): string {
  const id = asset.id ?? newObjectIdHex();
  db.run(
    `INSERT INTO assets
       (id, size, mtime, indexed_at, maple_id, media_kind, is_screenshot, place, exif,
        apple_rendered_path, deleted_at,
        backup_layout_version, legacy_daydir_version, video_meta_version,
        video_poster_rearm_version, video_screenshot_clear_version,
        preview_missing_redrive_version, geo_backfill_skipped)
     VALUES (?, 1024, 0, '2026-01-01T00:00:00.000Z', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      asset.mapleId ?? id,
      asset.mediaKind ?? 'image',
      asset.isScreenshot === undefined || asset.isScreenshot === null
        ? null
        : asset.isScreenshot
          ? 1
          : 0,
      asset.place == null ? null : JSON.stringify(asset.place),
      asset.exif == null ? null : JSON.stringify(asset.exif),
      asset.appleRenderedPath ?? null,
      asset.deletedAt ?? null,
      asset.backupLayoutVersion ?? null,
      asset.legacyDaydirVersion ?? null,
      asset.videoMetaVersion ?? null,
      asset.videoPosterRearmVersion ?? null,
      asset.videoScreenshotClearVersion ?? null,
      asset.previewMissingRedriveVersion ?? null,
      asset.geoBackfillSkipped ?? null,
    ],
  );
  if (asset.vision !== undefined || asset.geoInferred !== undefined) {
    db.run(
      `INSERT INTO asset_detail (asset_id, vision, geo_inferred) VALUES (?, json(?), json(?))`,
      [
        id,
        asset.vision == null ? null : JSON.stringify(asset.vision),
        asset.geoInferred == null ? null : JSON.stringify(asset.geoInferred),
      ],
    );
  }
  for (const device of asset.phassetDevices ?? []) {
    db.run(
      `INSERT INTO asset_phasset_links (asset_id, device_id, phasset_local_id, first_seen)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')`,
      [id, device, `${device}-${id}`],
    );
  }
  for (const stage of asset.stages ?? []) {
    db.run(`INSERT INTO stage_state (asset_id, stage) VALUES (?, ?)`, [id, stage]);
  }
  if (asset.location) {
    seedLocation(db, {
      assetId: id,
      libraryId: asset.location.libraryId,
      path: asset.location.path,
      filename: asset.location.filename,
      missingSince: asset.location.missingSince,
    });
  }
  return id;
}

/** Insert one location for a seeded asset. */
export function seedLocation(
  db: Database,
  location: {
    assetId: string;
    libraryId: ObjectId;
    ordinal?: number;
    path?: string;
    filename: string;
    deletedAt?: string | null;
    missingSince?: string | null;
  },
): void {
  db.run(
    `INSERT INTO asset_locations
       (asset_id, ordinal, library_id, path, filename, deleted_at, missing_since)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      location.assetId,
      location.ordinal ?? 0,
      location.libraryId.toHexString(),
      location.path ?? '',
      location.filename,
      location.deletedAt ?? null,
      location.missingSince ?? null,
    ],
  );
}

/** The columns the migrations write, read back for assertions. */
export interface MigrationAssetRow {
  id: string;
  media_kind: string;
  is_screenshot: number | null;
  exif: string | null;
  apple_rendered_path: string | null;
  live_location_count: number;
  backup_layout_version: number | null;
  legacy_daydir_version: number | null;
  video_meta_version: number | null;
  video_poster_rearm_version: number | null;
  video_screenshot_clear_version: number | null;
  preview_missing_redrive_version: number | null;
  geo_backfill_skipped: string | null;
}

const ASSET_COLUMNS = `id, media_kind, is_screenshot, exif, apple_rendered_path,
  live_location_count, backup_layout_version, legacy_daydir_version, video_meta_version,
  video_poster_rearm_version, video_screenshot_clear_version,
  preview_missing_redrive_version, geo_backfill_skipped`;

export function assetRow(db: Database, id: string): MigrationAssetRow | null {
  return db
    .query(`SELECT ${ASSET_COLUMNS} FROM assets WHERE id = ?`)
    .get(id) as MigrationAssetRow | null;
}

/** One asset's locations, in array order. */
export function locationsOf(
  db: Database,
  assetId: string,
): Array<{
  path: string;
  filename: string;
  deleted_at: string | null;
  missing_since: string | null;
}> {
  return db
    .query(
      `SELECT path, filename, deleted_at, missing_since FROM asset_locations
        WHERE asset_id = ? ORDER BY ordinal`,
    )
    .all(assetId) as Array<{
    path: string;
    filename: string;
    deleted_at: string | null;
    missing_since: string | null;
  }>;
}

/** One stage's bookkeeping, or null when no row was seeded. */
export function stageRow(
  db: Database,
  assetId: string,
  stage: string,
): { version: number; attempts: number; last_error: string | null; dead: number } | null {
  return db
    .query(
      `SELECT version, attempts, last_error, dead FROM stage_state
        WHERE asset_id = ? AND stage = ?`,
    )
    .get(assetId, stage) as {
    version: number;
    attempts: number;
    last_error: string | null;
    dead: number;
  } | null;
}

/** Park a stage the way a dead-lettered worker would, so a re-arm is visible. */
export function parkStage(db: Database, assetId: string, stage: string, lastError = 'boom'): void {
  db.run(
    `UPDATE stage_state
        SET version = 3, dead = 1, attempts = 5, last_error = ?,
            processed_at = '2026-01-01T00:00:00.000Z'
      WHERE asset_id = ? AND stage = ?`,
    [lastError, assetId, stage],
  );
}

/** The describe stage's stored screenshot verdict, for the flag-clearing sweep. */
export function visionScreenshot(db: Database, assetId: string): unknown {
  const row = db
    .query(
      `SELECT json_extract(vision, '$.is_screenshot') AS flag FROM asset_detail WHERE asset_id = ?`,
    )
    .get(assetId) as { flag: unknown } | null;
  return row?.flag ?? null;
}
