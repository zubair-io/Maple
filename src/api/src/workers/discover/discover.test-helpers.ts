/**
 * Shared fixtures for the discover-producer suites.
 *
 * Not a test file — the name does not match Bun's `*.test.ts` glob, so it never
 * runs on its own.
 *
 * Every suite here needs the same two things: a temporary directory on disk
 * that real files can be written into (the producer stats, hashes and reads
 * them, so none of this can be faked), and a database with that directory
 * registered as a library. {@link createDiscoverLibrary} returns both, installs
 * the database as the process-wide handle for the block, and removes the
 * directory when the block exits — `using`, so a failing assertion cannot skip
 * the cleanup.
 *
 * The read helpers below exist because a location is a row now. Assertions that
 * used to reach into `doc.fileinfo[0]` read `asset_locations` instead, and
 * spelling that query once keeps the suites about discover rather than about
 * SQL.
 */

import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObjectId } from 'mongodb';
import { toObjectId } from '../../db/sqlite/repos/values.ts';
import { createLiveTestDatabase, insertFolder } from '../../db/sqlite/test-sqlite.test-helpers.ts';

/** A registered library rooted at a real temporary directory. */
export interface DiscoverLibrary extends Disposable {
  readonly db: Database;
  /** Absolute path of the library root on disk. */
  readonly root: string;
  readonly folderId: ObjectId;
}

export async function createDiscoverLibrary(prefix: string): Promise<DiscoverLibrary> {
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

/**
 * Insert a pre-existing asset directly, for the cases that start from a row the
 * producer did not write: a reaped row being revived, and a legacy row that
 * predates content hashing.
 *
 * Takes the columns those cases actually vary and leaves the rest at their
 * schema defaults, so a test reads as the state it is setting up rather than as
 * a column list. Stage rows are seeded too, because a real asset always has
 * them — a re-arm assertion against an asset with no `stage_state` row would
 * pass for the wrong reason.
 */
export function seedAsset(
  db: Database,
  asset: {
    id: string;
    mapleId?: string | null;
    sha1Head?: string | null;
    size?: number;
    deletedAt?: string | null;
    deletedReason?: string | null;
    hidden?: boolean;
    hiddenReason?: 'manual' | 'nudity' | 'nudity-burst' | 'folder' | null;
    /** The sparse user-edit overlay, which lives in `asset_detail`. */
    metadataOverride?: Record<string, unknown>;
    /** The EXIF payload the rename fingerprint reads capture time and serial from. */
    exif?: object | null;
    rating?: number;
    flag?: number;
    colorLabel?: string;
    stages?: readonly string[];
  },
): string {
  db.run(
    `INSERT INTO assets
       (id, size, mtime, indexed_at, maple_id, sha1_head, deleted_at, deleted_reason,
        hidden, hidden_reason, rating, flag, color_label, exif)
     VALUES (?, ?, 0, '2026-08-01T00:00:00.000Z', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      asset.id,
      asset.size ?? 1024,
      asset.mapleId ?? null,
      asset.sha1Head ?? null,
      asset.deletedAt ?? null,
      asset.deletedReason ?? null,
      asset.hidden ? 1 : 0,
      asset.hiddenReason ?? null,
      asset.rating ?? 0,
      asset.flag ?? 0,
      asset.colorLabel ?? '',
      asset.exif == null ? null : JSON.stringify(asset.exif),
    ],
  );
  if (asset.metadataOverride !== undefined) {
    db.run(`INSERT INTO asset_detail (asset_id, metadata_override) VALUES (?, json(?))`, [
      asset.id,
      JSON.stringify(asset.metadataOverride),
    ]);
  }
  for (const stage of asset.stages ?? []) {
    db.run(`INSERT INTO stage_state (asset_id, stage) VALUES (?, ?)`, [asset.id, stage]);
  }
  return asset.id;
}

/** Insert one location for a seeded asset. */
export function seedLocation(
  db: Database,
  location: {
    assetId: string;
    libraryId: string;
    ordinal?: number;
    path?: string;
    filename: string;
    deletedAt?: string | null;
    missingSince?: string | null;
    missingReason?: string | null;
  },
): void {
  db.run(
    `INSERT INTO asset_locations
       (asset_id, ordinal, library_id, path, filename, deleted_at, missing_since, missing_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      location.assetId,
      location.ordinal ?? 0,
      location.libraryId,
      location.path ?? '',
      location.filename,
      location.deletedAt ?? null,
      location.missingSince ?? null,
      location.missingReason ?? null,
    ],
  );
}

/** One `asset_locations` row, as the suites assert on it. */
export interface LocationRow {
  asset_id: string;
  ordinal: number;
  library_id: string;
  path: string;
  filename: string;
  deleted_at: string | null;
  missing_since: string | null;
  missing_reason: string | null;
  keep: number;
}

const LOCATION_COLUMNS = `asset_id, ordinal, library_id, path, filename,
  deleted_at, missing_since, missing_reason, keep`;

/** Every location of one asset, in array order. */
export function locationsOf(db: Database, assetId: string): LocationRow[] {
  return db
    .query(`SELECT ${LOCATION_COLUMNS} FROM asset_locations WHERE asset_id = ? ORDER BY ordinal`)
    .all(assetId) as LocationRow[];
}

/** Every location with this filename, whichever asset holds it. */
export function locationsNamed(db: Database, filename: string): LocationRow[] {
  return db
    .query(`SELECT ${LOCATION_COLUMNS} FROM asset_locations WHERE filename = ? ORDER BY path`)
    .all(filename) as LocationRow[];
}

/** The asset holding a location, addressed the way the producer keys on one. */
export function assetIdAt(db: Database, path: string, filename: string): string | null {
  const row = db
    .query(`SELECT asset_id FROM asset_locations WHERE path = ? AND filename = ?`)
    .get(path, filename) as { asset_id: string } | null;
  return row?.asset_id ?? null;
}

/** The narrow asset row the suites assert on. */
export interface AssetRow {
  id: string;
  size: number;
  mtime: number;
  maple_id: string | null;
  sha1_head: string | null;
  media_kind: string;
  deleted_at: string | null;
  deleted_reason: string | null;
  live_location_count: number;
  hidden: number;
  hidden_reason: string | null;
}

const ASSET_COLUMNS = `id, size, mtime, maple_id, sha1_head, media_kind,
  deleted_at, deleted_reason, live_location_count, hidden, hidden_reason`;

export function assetRow(db: Database, id: string): AssetRow | null {
  return db.query(`SELECT ${ASSET_COLUMNS} FROM assets WHERE id = ?`).get(id) as AssetRow | null;
}

/** Every asset in the database, oldest id first — for "how many rows" checks. */
export function allAssets(db: Database): AssetRow[] {
  return db.query(`SELECT ${ASSET_COLUMNS} FROM assets ORDER BY id`).all() as AssetRow[];
}

/** One stage's bookkeeping for an asset, or null when no row was seeded. */
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

/** The change-feed rows for one absolute path, oldest cursor first. */
export function changesFor(
  db: Database,
  absPath: string,
): Array<{ cursor: number; kind: string; asset_id: string | null }> {
  return db
    .query(`SELECT cursor, kind, asset_id FROM asset_changes WHERE abs_path = ? ORDER BY cursor`)
    .all(absPath) as Array<{ cursor: number; kind: string; asset_id: string | null }>;
}

/** Park a stage the way a dead-lettered worker would, so a re-arm is visible. */
export function deadLetterStage(db: Database, assetId: string, stage: string): void {
  db.run(
    `UPDATE stage_state
        SET version = 3, dead = 1, attempts = 5, last_error = 'boom',
            processed_at = '2024-01-01T00:00:00.000Z'
      WHERE asset_id = ? AND stage = ?`,
    [assetId, stage],
  );
}

/** Set one stage's version, standing in for "a worker processed this asset". */
export function setStageVersion(
  db: Database,
  assetId: string,
  stage: string,
  version: number,
): void {
  db.run(`UPDATE stage_state SET version = ? WHERE asset_id = ? AND stage = ?`, [
    version,
    assetId,
    stage,
  ]);
}
