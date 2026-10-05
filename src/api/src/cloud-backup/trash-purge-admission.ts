import type { FileInfo } from '../db/schema.ts';

/** Exact Trash state selected by retention or the permanent-delete request. */
export interface TrashPurgeCandidate {
  deletedAt: string | null;
  deletedReason: string | null;
  appleRenderedPath: string | null;
  locations: Array<{
    libraryId: string;
    path: string;
    filename: string;
    deletedAt: string | null;
    missingSince: string | null;
  }>;
}
export function capturedTrashPurge(info: {
  deleted_at: string | null;
  deleted_reason: string | null;
  apple_rendered_path?: string;
  fileinfo?: FileInfo[];
}): TrashPurgeCandidate {
  return {
    deletedAt: info.deleted_at,
    deletedReason: info.deleted_reason,
    appleRenderedPath: info.apple_rendered_path ?? null,
    locations: (info.fileinfo ?? []).map((location) => ({
      libraryId: location.library_id.toHexString(),
      path: location.path,
      filename: location.filename,
      deletedAt: location.deleted_at ?? null,
      missingSince: location.missing_since ?? null,
    })),
  };
}

/** Evaluated in the same writer transaction that admits purge and fences history. */
export function trashPurgeGuard(candidate: TrashPurgeCandidate) {
  return {
    sql: `AND a.deleted_at IS NOT NULL AND a.deleted_at=? AND a.deleted_reason IS ?
      AND a.apple_rendered_path IS ?
      AND (SELECT COUNT(*) FROM asset_locations WHERE asset_id=a.id)=?
      AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS
        (SELECT 1 FROM asset_locations l WHERE l.asset_id=a.id
          AND l.library_id=json_extract(expected.value,'$.libraryId')
          AND l.path=json_extract(expected.value,'$.path')
          AND l.filename=json_extract(expected.value,'$.filename')
          AND l.deleted_at IS json_extract(expected.value,'$.deletedAt')
          AND l.missing_since IS json_extract(expected.value,'$.missingSince')))`,
    params: [
      candidate.deletedAt,
      candidate.deletedReason,
      candidate.appleRenderedPath,
      candidate.locations.length,
      JSON.stringify(candidate.locations),
    ],
  };
}
