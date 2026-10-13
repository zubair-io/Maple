/**
 * The rows the search child's keyword text is rendered from: an asset's description, OCR and
 * transcript text, place, face people and locations, and its `search_blob`, looked up by content
 * id.
 *
 * Locations and faces are one-to-many, so they are separate statements against the ids the first
 * query chose rather than a join that would multiply the asset rows. Face embeddings and landmarks
 * are not selected; only `person_id` feeds the text.
 */

import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { placeholders } from './values.ts';
import type { LocationRow } from './assets.rows.ts';
import { groupByAsset } from './assets.rows.ts';
import { locationsByAssetIdsSql } from './assets.sql.ts';

export interface SearchDocumentAssetRow {
  id: string;
  maple_id: string;
  place: string | null;
  description: string | null;
  ocr_text: string | null;
  transcript: string | null;
  search_blob: string | null;
}

export interface SearchDocumentFaceRow {
  asset_id: string;
  person_id: string | null;
}

export interface SearchDocumentBatch {
  rows: SearchDocumentAssetRow[];
  locations: Map<string, LocationRow[]>;
  faces: Map<string, SearchDocumentFaceRow[]>;
}

export async function loadSearchDocumentRows(
  mapleIds: readonly string[],
  dbOverride?: SqliteDb,
): Promise<SearchDocumentBatch> {
  if (mapleIds.length === 0) return { rows: [], locations: new Map(), faces: new Map() };
  const db = sqliteDb(dbOverride);
  const rows = await db.read<SearchDocumentAssetRow>(
    `SELECT a.id, a.maple_id, a.place, d.description, d.ocr_text, d.transcript, s.search_blob
       FROM assets a
       LEFT JOIN asset_detail d ON d.asset_id = a.id
       LEFT JOIN asset_search s ON s.asset_id = a.id
      WHERE a.maple_id IN (${placeholders(mapleIds.length)})`,
    [...mapleIds],
  );
  if (rows.length === 0) return { rows, locations: new Map(), faces: new Map() };
  const ids = rows.map((row) => row.id);
  const [locations, faces] = await Promise.all([
    db.read<LocationRow>(locationsByAssetIdsSql(ids.length), ids),
    db.read<SearchDocumentFaceRow>(
      `SELECT asset_id, person_id FROM faces
        WHERE asset_id IN (${placeholders(ids.length)}) ORDER BY asset_id, face_index`,
      ids,
    ),
  ]);
  return { rows, locations: groupByAsset(locations), faces: groupByAsset(faces) };
}
