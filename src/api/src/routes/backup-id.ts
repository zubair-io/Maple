import type { ObjectId } from '../db/object-id.ts';
import { safeObjectId } from '../db/object-id.ts';
import { findFolderById } from '../db/repos/folders.repo.ts';
import type { FolderWithId } from '../db/schema.ts';
import { fromHex, isMapleId } from '../indexer/id.ts';

/**
 * The `:libraryId` path parameter as an id, or the 400 to return instead.
 *
 * All four backup routes open by parsing it, and all four answered the same
 * `{ error: 'invalid library id' }` from their own copy of the same try/catch.
 * `safeObjectId` accepts exactly what the constructor accepted — 24 hex
 * characters, either case — so this is the same verdict in one place.
 */
export function backupLibraryId(raw: string): ObjectId | Response {
  return safeObjectId(raw) ?? badRequest({ error: 'invalid library id' });
}

/** The library the request names, or the 404 to return instead. */
export async function backupLibrary(id: ObjectId): Promise<FolderWithId | Response> {
  const folder = await findFolderById(id);
  return folder ?? Response.json({ error: 'library not found' }, { status: 404 });
}

/** Normalize optional client IDs before any upload or sidecar state changes. */
export function backupId(value: string | undefined, header: string): string | undefined | Response {
  if (value === undefined) return undefined;
  if (!isMapleId(value)) return badRequest({ error: `invalid ${header}` });
  return fromHex(value).hex;
}

/** Validate the shared chunk headers before either upload route opens a session. */
export function backupChunkRange(totalBytesRaw: string, range: string, id: string | undefined) {
  const totalBytes = parseInt(totalBytesRaw, 10);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return badRequest({ error: 'invalid X-Maple-Total-Bytes' });
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
  if (!match) return badRequest({ error: 'invalid Content-Range' });
  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);
  const rangeTotal = parseInt(match[3], 10);
  if (end < start) return badRequest({ error: 'invalid Content-Range: end must be >= start' });
  if (end >= rangeTotal) return badRequest({ error: 'invalid Content-Range: end must be < total' });
  if (rangeTotal !== totalBytes) {
    return badRequest({ error: 'Content-Range total mismatch with X-Maple-Total-Bytes' });
  }
  if (end + 1 === rangeTotal && !id) {
    return badRequest({ error: 'X-Maple-Maple-Id required on final chunk' });
  }
  return { start, end, rangeTotal, totalBytes };
}

function badRequest(body: { error: string }): Response {
  return Response.json(body, { status: 400 });
}
