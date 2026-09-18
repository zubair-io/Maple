/**
 * Fixture builders for the tables an asset's DTO draws on.
 *
 * The {@link SqliteDb} adapter these tests also need moved to the shared
 * harness when the change feed became the second ported repository — see
 * `testSqliteDb` in `../test-sqlite.test-helpers.ts`.
 */

import type { Database } from 'bun:sqlite';
import { newObjectIdHex } from '../object-id.ts';
import { run } from '../test-sqlite.test-helpers.ts';

/** Inserts an `asset_detail` row. Every payload column is optional. */
export function insertDetail(
  db: Database,
  assetId: string,
  overrides: {
    description?: string | null;
    descriptionMeta?: string | null;
    ocrText?: string | null;
    ocrMeta?: string | null;
    vision?: string | null;
    visionMeta?: string | null;
    transcript?: string | null;
    videoDescription?: string | null;
    videoDescriptionMeta?: string | null;
  } = {},
): void {
  run(
    db,
    `INSERT INTO asset_detail
       (asset_id, description, description_meta, ocr_text, ocr_meta, vision, vision_meta,
        transcript, video_description, video_description_meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    assetId,
    overrides.description ?? null,
    overrides.descriptionMeta ?? null,
    overrides.ocrText ?? null,
    overrides.ocrMeta ?? null,
    overrides.vision ?? null,
    overrides.visionMeta ?? null,
    overrides.transcript ?? null,
    overrides.videoDescription ?? null,
    overrides.videoDescriptionMeta ?? null,
  );
}

/** Inserts a person and returns its id. */
export function insertPerson(db: Database, name: string, id = newObjectIdHex()): string {
  const now = new Date().toISOString();
  run(
    db,
    `INSERT INTO people (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    id,
    name,
    now,
    now,
  );
  return id;
}

/** Inserts one detected face on an asset. */
export function insertFace(
  db: Database,
  args_: {
    assetId: string;
    faceIndex?: number;
    personId?: string | null;
    confidence?: number;
    bbox?: { x: number; y: number; w: number; h: number };
    hidden?: boolean;
    landmarks?: string | null;
    embedding?: string | null;
    embeddingVersion?: string | null;
  },
): void {
  const bbox = args_.bbox ?? { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  run(
    db,
    `INSERT INTO faces
       (asset_id, face_index, person_id, confidence, bbox_x, bbox_y, bbox_w, bbox_h,
        hidden, landmarks, embedding, embedding_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args_.assetId,
    args_.faceIndex ?? 0,
    args_.personId ?? null,
    args_.confidence ?? 0.9,
    bbox.x,
    bbox.y,
    bbox.w,
    bbox.h,
    args_.hidden === true ? 1 : 0,
    args_.landmarks ?? null,
    args_.embedding ?? null,
    args_.embeddingVersion ?? null,
  );
}

/** Inserts one Apple Photos link for an asset. */
export function insertPhassetLink(
  db: Database,
  args_: {
    assetId: string;
    deviceId: string;
    phassetLocalId: string;
    phassetCloudId?: string | null;
    firstSeen?: string;
  },
): void {
  run(
    db,
    `INSERT INTO asset_phasset_links
       (asset_id, device_id, phasset_local_id, phasset_cloud_id, first_seen)
     VALUES (?, ?, ?, ?, ?)`,
    args_.assetId,
    args_.deviceId,
    args_.phassetLocalId,
    args_.phassetCloudId ?? null,
    args_.firstSeen ?? new Date().toISOString(),
  );
}

/** Seeds one `stage_state` row, as asset creation will once #3748 lands. */
export function insertStageState(
  db: Database,
  assetId: string,
  stage: string,
  overrides: { version?: number; attempts?: number; dead?: boolean; processedAt?: string } = {},
): void {
  run(
    db,
    `INSERT INTO stage_state (asset_id, stage, version, attempts, dead, processed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    assetId,
    stage,
    overrides.version ?? 0,
    overrides.attempts ?? 0,
    overrides.dead === true ? 1 : 0,
    overrides.processedAt ?? null,
  );
}

/** Inserts one `enrichment_state` row. */
export function insertEnrichmentState(
  db: Database,
  assetId: string,
  stage: 'geocode' | 'face' | 'describe',
  overrides: {
    doneAt?: string | null;
    lockedBy?: string | null;
    leaseExpiresAt?: string | null;
    attempts?: number;
    lastError?: string | null;
    version?: number | null;
    deadLetterAt?: string | null;
  } = {},
): void {
  run(
    db,
    `INSERT INTO enrichment_state
       (asset_id, stage, done_at, locked_by, lease_expires_at, attempts, last_error,
        version, dead_letter_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    assetId,
    stage,
    overrides.doneAt ?? null,
    overrides.lockedBy ?? null,
    overrides.leaseExpiresAt ?? null,
    overrides.attempts ?? 0,
    overrides.lastError ?? null,
    overrides.version ?? null,
    overrides.deadLetterAt ?? null,
  );
}

/** Reads one `stage_state` row, or `null`. */
export function stageState(
  db: Database,
  assetId: string,
  stage: string,
): { version: number; attempts: number; dead: number; processed_at: string | null } | null {
  return (db
    .query(
      `SELECT version, attempts, dead, processed_at FROM stage_state WHERE asset_id = ? AND stage = ?`,
    )
    .get(assetId, stage) ?? null) as {
    version: number;
    attempts: number;
    dead: number;
    processed_at: string | null;
  } | null;
}
