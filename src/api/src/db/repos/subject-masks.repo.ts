/**
 * Repository for person segmentation documents (#4284, #3300 slice 3).
 */

import { sqliteDb, type SqliteDb } from './db-handle.ts';
import type { SqlStatement } from '../sqlite/protocol.ts';

export interface DetectedPerson {
  person: number;
  bbox: { x: number; y: number; width: number; height: number };
}

export interface SubjectMaskDoc {
  model: string;
  persons: DetectedPerson[];
}

interface PersonSegmentationRow {
  model: string;
  persons: string;
}

const SELECT_SEGMENTATION_SQL = `
  SELECT model, persons FROM person_segmentations WHERE asset_id = ?
`;

const UPSERT_SEGMENTATION_SQL = `
  INSERT INTO person_segmentations (asset_id, model, persons, created_at)
  VALUES (?, ?, json(?), ?)
  ON CONFLICT(asset_id) DO UPDATE SET
    model = excluded.model,
    persons = excluded.persons,
    created_at = excluded.created_at
`;

export function personSegmentationStatements(
  assetId: string,
  model: string,
  persons: readonly DetectedPerson[],
  createdAt: string = new Date().toISOString(),
): SqlStatement[] {
  return [
    {
      sql: UPSERT_SEGMENTATION_SQL,
      params: [assetId, model, JSON.stringify(persons), createdAt],
    },
  ];
}

export async function getPersonSegmentation(
  assetKey: string,
  dbOverride?: SqliteDb,
): Promise<SubjectMaskDoc | null> {
  const db = sqliteDb(dbOverride);

  // 1. Direct match on assetKey as asset_id
  let rows = await db.read<PersonSegmentationRow>(SELECT_SEGMENTATION_SQL, [assetKey]);
  if (rows.length > 0) {
    return {
      model: rows[0].model,
      persons: JSON.parse(rows[0].persons) as DetectedPerson[],
    };
  }

  // 2. If assetKey is an address (slug:relPath), resolve asset_id from asset_locations + folders
  if (assetKey.includes(':')) {
    const colonIdx = assetKey.indexOf(':');
    const slug = assetKey.slice(0, colonIdx);
    const relPath = assetKey.slice(colonIdx + 1).replace(/^\/+/, '');
    const lastSlash = relPath.lastIndexOf('/');
    const dirPath = lastSlash === -1 ? '' : relPath.slice(0, lastSlash);
    const filename = lastSlash === -1 ? relPath : relPath.slice(lastSlash + 1);

    const locRows = await db.read<{ asset_id: string }>(
      `SELECT al.asset_id
         FROM asset_locations al
         JOIN folders f ON f.id = al.library_id
        WHERE f.slug = ? AND al.path = ? AND al.filename = ?`,
      [slug, dirPath, filename],
    );

    if (locRows.length > 0) {
      const resolvedId = locRows[0].asset_id;
      rows = await db.read<PersonSegmentationRow>(SELECT_SEGMENTATION_SQL, [resolvedId]);
      if (rows.length > 0) {
        return {
          model: rows[0].model,
          persons: JSON.parse(rows[0].persons) as DetectedPerson[],
        };
      }
    }
  }

  return null;
}
