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
import type { ObjectId } from '../../db/object-id.ts';
import { newObjectIdHex } from '../../db/object-id.ts';
import { toObjectId } from '../../db/sqlite/repos/values.ts';
import { createTempLibrary } from '../../db/sqlite/test-sqlite.test-helpers.ts';

/** A registered library rooted at a real temporary directory. */
export interface MigrationLibrary extends Disposable {
  readonly db: Database;
  readonly root: string;
  readonly folderId: ObjectId;
}

export async function createLibrary(prefix = 'maple-migration-'): Promise<MigrationLibrary> {
  const library = await createTempLibrary(prefix);
  return { ...library, folderId: toObjectId(library.folderId) };
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

/** A value bound into one of the columns below. */
type ColumnValue = string | number | null;

/**
 * Every `assets` column a fixture can set, with the value it takes when the
 * fixture does not set one.
 *
 * This is a table rather than a run of `x ?? null` fallbacks inside the insert
 * because {@link SeedAsset} grows by one optional field per migration: written
 * as fallbacks, every new done-marker column added another branch to the one
 * function that wrote them all, and that function ended up branching more than
 * two dozen ways. As data, a new column is one line here and no new decision
 * anywhere.
 *
 * `maple_id` defaults to the asset's own id because the migrations that select
 * on it only care that a backup-origin asset has one at all.
 */
function defaultColumns(id: string): Record<string, ColumnValue> {
  return {
    maple_id: id,
    media_kind: 'image',
    is_screenshot: null,
    place: null,
    exif: null,
    apple_rendered_path: null,
    deleted_at: null,
    backup_layout_version: null,
    legacy_daydir_version: null,
    video_meta_version: null,
    video_poster_rearm_version: null,
    video_screenshot_clear_version: null,
    preview_missing_redrive_version: null,
    geo_backfill_skipped: null,
  };
}

/**
 * The columns this fixture actually asked for, in the same vocabulary.
 *
 * A column the caller left out is dropped rather than passed as null, so the
 * defaults above survive the merge. An explicit `null` is dropped too, which is
 * what the old fallback chain did as well: to these suites "I did not set this"
 * and "I set this to nothing" have always meant the same thing.
 */
function requestedColumns(asset: SeedAsset): Record<string, ColumnValue> {
  const requested: Record<string, ColumnValue | undefined> = {
    maple_id: asset.mapleId,
    media_kind: asset.mediaKind,
    is_screenshot: asBit(asset.isScreenshot),
    place: asJson(asset.place),
    exif: asJson(asset.exif),
    apple_rendered_path: asset.appleRenderedPath,
    deleted_at: asset.deletedAt,
    backup_layout_version: asset.backupLayoutVersion,
    legacy_daydir_version: asset.legacyDaydirVersion,
    video_meta_version: asset.videoMetaVersion,
    video_poster_rearm_version: asset.videoPosterRearmVersion,
    video_screenshot_clear_version: asset.videoScreenshotClearVersion,
    preview_missing_redrive_version: asset.previewMissingRedriveVersion,
    geo_backfill_skipped: asset.geoBackfillSkipped,
  };
  return Object.fromEntries(
    Object.entries(requested).filter((entry): entry is [string, ColumnValue] => entry[1] != null),
  );
}

/** SQLite has no boolean: a flag is 1 or 0, and an unasked question is null. */
function asBit(flag: boolean | null | undefined): number | null {
  if (flag == null) return null;
  return flag ? 1 : 0;
}

/** JSON columns take text; an object the fixture did not supply stays null. */
function asJson(value: object | null | undefined): string | null {
  return value == null ? null : JSON.stringify(value);
}

/** Insert one asset in the state a migration's predicate is meant to judge. */
export function seedAsset(db: Database, asset: SeedAsset): string {
  const id = asset.id ?? newObjectIdHex();
  const columns = { ...defaultColumns(id), ...requestedColumns(asset) };
  const names = Object.keys(columns);
  db.run(
    `INSERT INTO assets (id, size, mtime, indexed_at, ${names.join(', ')})
     VALUES (?, 1024, 0, '2026-01-01T00:00:00.000Z', ${names.map(() => '?').join(', ')})`,
    [id, ...Object.values(columns)],
  );
  seedDetail(db, id, asset);
  seedPhassetLinks(db, id, asset.phassetDevices);
  seedStages(db, id, asset.stages);
  seedSoleLocation(db, id, asset.location);
  return id;
}

/**
 * The `asset_detail` row, which only exists when a fixture asks for one.
 *
 * `undefined` means "no row at all", which is the state of an asset the
 * describe stage has never looked at. An explicit `null` writes a row with a
 * null column instead — what a describe run that found nothing leaves behind —
 * and the two select differently, so the distinction is load-bearing.
 */
function seedDetail(db: Database, id: string, asset: SeedAsset): void {
  if (asset.vision === undefined && asset.geoInferred === undefined) return;
  db.run(`INSERT INTO asset_detail (asset_id, vision, geo_inferred) VALUES (?, json(?), json(?))`, [
    id,
    asJson(asset.vision),
    asJson(asset.geoInferred),
  ]);
}

/** One PHAsset link per device id — what "came from a mobile backup" means. */
function seedPhassetLinks(db: Database, id: string, devices: readonly string[] = []): void {
  for (const device of devices) {
    db.run(
      `INSERT INTO asset_phasset_links (asset_id, device_id, phasset_local_id, first_seen)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')`,
      [id, device, `${device}-${id}`],
    );
  }
}

/** Stage rows at their schema defaults — a migration that re-arms a stage needs
 * one to exist before it can observe the re-arm. */
function seedStages(db: Database, id: string, stages: readonly string[] = []): void {
  for (const stage of stages) {
    db.run(`INSERT INTO stage_state (asset_id, stage) VALUES (?, ?)`, [id, stage]);
  }
}

/** The one location almost every predicate needs the asset to have. */
function seedSoleLocation(db: Database, id: string, location: SeedAsset['location']): void {
  if (!location) return;
  seedLocation(db, { assetId: id, ...location });
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

// The stage-table fixtures are shared with the discover suites — the reader and
// the parker are the same two operations there, so they live one directory up
// in `stage-state.test-helpers.ts` and are re-exported here, so a migration
// suite still gets everything it needs from one import.
export { parkStage, stageRow } from '../stage-state.test-helpers.ts';

/** The describe stage's stored screenshot verdict, for the flag-clearing sweep. */
export function visionScreenshot(db: Database, assetId: string): unknown {
  const row = db
    .query(
      `SELECT json_extract(vision, '$.is_screenshot') AS flag FROM asset_detail WHERE asset_id = ?`,
    )
    .get(assetId) as { flag: unknown } | null;
  return row?.flag ?? null;
}
