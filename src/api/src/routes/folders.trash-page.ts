import type { FolderTrashRow } from '../db/repos/folder-assets.repo.ts';
import { assetAbsPath } from '../indexer/images.repo.ts';

/** Preserve the existing parseInt/clamp contract, including an empty limit's default. */
export function parseFolderTrashPage(query: { limit?: string; cursor?: string }) {
  const raw = query.limit;
  const limit = typeof raw === 'string' && raw.length > 0 ? Number.parseInt(raw, 10) : 100;
  if (!Number.isFinite(limit) || limit < 1)
    return { error: 'Invalid limit — must be a positive integer' } as const;
  const cursor = typeof query.cursor === 'string' && query.cursor.length > 0 ? query.cursor : null;
  return { limit: Math.min(500, limit), cursor } as const;
}
function relativeToRoot(value: string, rootPrefix: string): string {
  return value.startsWith(rootPrefix) ? value.slice(rootPrefix.length) : value;
}
export function folderTrashItem(
  doc: FolderTrashRow,
  rootPrefix: string,
  libs: ReadonlyMap<string, string>,
) {
  const primary = doc.fileinfo.find((entry) => !entry.deleted_at) ?? doc.fileinfo[0];
  if (!primary) return null;
  const isReaped = doc.deleted_reason === 'reaped';
  const storedRel = primary.path === '' ? primary.filename : `${primary.path}/${primary.filename}`;
  const originalRel = isReaped ? storedRel : relativeToRoot(doc.original_path ?? '', rootPrefix);
  const absolute = isReaped ? null : assetAbsPath(doc, libs);
  if (!isReaped && !absolute) return null;
  return {
    asset_id: doc._id.toHexString(),
    filename: primary.filename,
    original_relative_path: originalRel,
    trash_relative_path: isReaped ? storedRel : relativeToRoot(absolute!, rootPrefix),
    size: doc.size,
    mtime: new Date(doc.mtime).toISOString(),
    deleted_at: doc.deleted_at,
    reason: isReaped ? ('reaped' as const) : ('user' as const),
    owner_id: doc.owner_id,
    owner: doc.owner,
  };
}
