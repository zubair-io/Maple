/**
 * Fixtures the stage-runtime suites share: a claimable asset, and a reader for
 * the whole `stage_state` row.
 *
 * `assets.test-helpers.ts` already supplies `testSqliteDb`, `insertStageState`
 * and a narrow `stageState` reader, and those stay as they are — the narrow
 * reader is asserted with `toEqual` by the assets suites, so widening it would
 * break them. What the runtime suites need on top is the retry and claim
 * bookkeeping (`last_error`, `failed_at`, `next_attempt_at`), which is the
 * whole subject here.
 */

import type { Database } from 'bun:sqlite';
import { insertStageState } from './assets.test-helpers.ts';
import { insertAsset, insertFolder, insertLocation } from '../test-sqlite.test-helpers.ts';

/** Every column of one `stage_state` row, or null when there is none. */
export interface StageRow {
  asset_id: string;
  stage: string;
  version: number;
  attempts: number;
  last_error: string | null;
  processed_at: string | null;
  dead: number;
  failed_at: string | null;
  next_attempt_at: string | null;
}

export function stageRow(db: Database, assetId: string, stage: string): StageRow | null {
  return (db
    .query(`SELECT * FROM stage_state WHERE asset_id = ? AND stage = ?`)
    .get(assetId, stage) ?? null) as StageRow | null;
}

/** An asset's `damaged_*` tag columns. */
export function damagedTag(
  db: Database,
  assetId: string,
): { damaged_since: string | null; damaged_stage: string | null; damaged_reason: string | null } {
  return db
    .query(`SELECT damaged_since, damaged_stage, damaged_reason FROM assets WHERE id = ?`)
    .get(assetId) as {
    damaged_since: string | null;
    damaged_stage: string | null;
    damaged_reason: string | null;
  };
}

export interface SeedOptions {
  /** Stage rows to create, name → state. Absent stages get no row at all. */
  stages?: Record<string, Parameters<typeof insertStageState>[3] & Record<string, unknown>>;
  /** Leave the asset with no live location, so every stage parks it. */
  missing?: boolean;
  deletedAt?: string | null;
  mediaKind?: 'image' | 'video' | 'audio';
}

/**
 * One asset with a live location and the stage rows a test asks for.
 *
 * The library is created per call rather than shared, because every test here
 * gets its own database and a per-test library keeps the fixtures independent
 * of insertion order.
 */
export function seedClaimableAsset(db: Database, options: SeedOptions = {}): string {
  const libraryId = insertFolder(db);
  const assetId = insertAsset(db, { deletedAt: options.deletedAt ?? null });
  insertLocation(db, {
    assetId,
    libraryId,
    missingSince: options.missing === true ? new Date().toISOString() : null,
  });
  if (options.mediaKind !== undefined) {
    db.run(`UPDATE assets SET media_kind = ? WHERE id = ?`, [options.mediaKind, assetId]);
  }
  for (const [stage, state] of Object.entries(options.stages ?? {})) {
    insertStageState(db, assetId, stage, state);
  }
  return assetId;
}

/** `n` assets, each with one live location and one row for `stage` at v0. */
export function seedClaimableAssets(db: Database, stage: string, n: number): string[] {
  return Array.from({ length: n }, () => seedClaimableAsset(db, { stages: { [stage]: {} } }));
}
