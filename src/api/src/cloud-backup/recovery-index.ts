import * as path from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import { seedStageRowStatements } from '../db/repos/stage-state.repo.ts';
import type { SqlStatement } from '../db/sqlite/protocol.ts';
import { sqliteDb } from '../db/repos/db-handle.ts';
import { hashFileForId } from '../indexer/id.ts';
import { classifyMediaType } from '../indexer/media-types.ts';
import { ALL_STAGE_NAMES } from '../workers/stages/stage-names.ts';
import { findAssetForContent, isMapleIdConflict } from '../db/repos/assets.discover.dedup.ts';
import type { BackupManifest } from './provider.ts';

/** Recovery indexes the actual file, including reserved Trash paths. No active
 * alias is created, so another restored photo can safely occupy originalPath. */
export async function indexRecoveredEntry(
  root: string,
  folderId: ObjectId,
  manifest: BackupManifest,
): Promise<void> {
  const original = manifest.files.find((file) => file.role === 'original')!;
  const absolute = path.join(root, original.path);
  const hash = await hashFileForId(absolute);
  const location = {
    library_id: folderId,
    path: path.posix.dirname(original.path) === '.' ? '' : path.posix.dirname(original.path),
    filename: path.posix.basename(original.path),
    keep: false,
  };
  const existing = await findAssetForContent(hash.maple_id, hash.sha1_head);
  const id = existing?.id ?? new ObjectId();
  const db = sqliteDb();
  // Metadata is asset-wide. Refuse a conflicting live dedup instead of hiding,
  // deleting, or changing another library's photo as a side effect of recovery.
  const companion = manifest.files.find((file) => file.role === 'companion')?.path ?? null;
  const at = new Date().toISOString();
  const insert: SqlStatement[] = existing
    ? []
    : [
        {
          sql: `INSERT INTO assets
    (id,size,mtime,indexed_at,rating,flag,color_label,media_kind,maple_id,sha1_head,owner_id)
    VALUES(?,?,?,?,0,0,'',?,?,?,(SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1))`,
          params: [
            id.toHexString(),
            hash.size,
            hash.mtime,
            at,
            classifyMediaType(location.filename),
            hash.maple_id,
            hash.sha1_head,
          ],
        },
        ...seedStageRowStatements(id.toHexString(), ALL_STAGE_NAMES),
      ];
  try {
    await db.transaction([
      ...insert,
      {
        sql: `INSERT INTO asset_locations(asset_id,ordinal,library_id,path,filename,keep)
        SELECT ?,COALESCE(MAX(ordinal)+1,0),?,?,?,0 FROM asset_locations WHERE asset_id=?
        ON CONFLICT(library_id,path,filename) DO NOTHING`,
        params: [
          id.toHexString(),
          folderId.toHexString(),
          location.path,
          location.filename,
          id.toHexString(),
        ],
      },
      {
        sql: `UPDATE asset_locations SET deleted_at=NULL,missing_since=NULL,missing_reason=NULL
        WHERE asset_id=? AND library_id=? AND path=? AND filename=?`,
        params: [id.toHexString(), folderId.toHexString(), location.path, location.filename],
      },
      {
        sql: `UPDATE assets SET deleted_at=?,original_path=?,hidden=CASE WHEN
        EXISTS(SELECT 1 FROM asset_locations l WHERE l.asset_id=assets.id AND l.deleted_at IS NULL
          AND l.missing_since IS NULL AND NOT(l.library_id=? AND l.path=? AND l.filename=?)
          AND assets.deleted_at IS NULL AND (?='trash' OR assets.hidden<>? OR
            assets.apple_rendered_path IS NOT ?))
        OR EXISTS(SELECT 1 FROM asset_locations l WHERE l.library_id=? AND l.path=? AND l.filename=?
          AND l.asset_id<>assets.id) THEN 2 ELSE ? END,hidden_reason=?,apple_rendered_path=?,
        indexed_at=?,mtime=?,size=? WHERE id=?`,
        params: [
          manifest.state === 'trash' ? manifest.deletedAt : null,
          manifest.state === 'trash' ? path.join(root, manifest.originalPath) : null,
          folderId.toHexString(),
          location.path,
          location.filename,
          manifest.state,
          Number(manifest.hidden),
          companion,
          folderId.toHexString(),
          location.path,
          location.filename,
          Number(manifest.hidden),
          manifest.hidden ? 'manual' : null,
          companion,
          new Date().toISOString(),
          hash.mtime,
          hash.size,
          id.toHexString(),
        ],
      },
    ]);
  } catch (error) {
    if (isMapleIdConflict(error)) return indexRecoveredEntry(root, folderId, manifest);
    if (error instanceof Error && /CHECK constraint failed.*hidden/i.test(error.message))
      throw new Error(
        'Recovery metadata conflicts with an existing live copy; restore into a separate Maple server',
        { cause: error },
      );
    throw error;
  }
}
