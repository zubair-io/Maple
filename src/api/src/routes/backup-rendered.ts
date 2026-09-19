/**
 * POST /api/libraries/:libraryId/backup/rendered
 *
 * Chunked, resumable upload of an Apple-rendered companion file (the
 * Photos-edited version stored alongside the original). Mirrors the shape of
 * backup-ingest.ts; the assembled file lands at:
 *
 *   <library>/<base>.rendered.<ext>
 *
 * where <base> is the original's rel-path without its extension.
 *
 * Headers:
 *   X-Maple-Device-Id       — required
 *   X-Maple-Phasset-Id      — required
 *   X-Maple-Target-Rel-Path — required — original's rel path (e.g. "2024/Tokyo/IMG.HEIC")
 *   X-Maple-Total-Bytes     — required
 *   Content-Range           — required (bytes <start>-<end>/<total>)
 *   X-Maple-Filename-Ext    — optional; extension of the rendered file.
 *                             Defaults to the extension of X-Maple-Target-Rel-Path.
 *   X-Maple-Suffix-Override — optional; when set, the final filename is
 *                             `<base>.<suffix-override>` instead of
 *                             `<base>.rendered.<ext>`. Used by the Live Photo
 *                             .mov path to skip the `.rendered.` infix.
 *   X-Maple-PHAsset-Cloud-Id — optional; Apple PHCloudIdentifier. When two
 *                             devices on the same iCloud library both back
 *                             up the rendered companion for the same photo,
 *                             openOrResume returns 423 to the second device.
 *   X-Maple-Maple-Id        — required on the final chunk
 *
 * Responses:
 *   202 — chunk accepted. { next_offset }
 *   200 — final chunk. { target_rel_path }
 *   400 — missing/invalid headers, unsafe path
 *   404 — library not found
 *   409 — resume offset mismatch
 *   423 — another device is actively uploading the same iCloud photo.
 *         Body: { retry_after_seconds }. Same-key metadata mismatches
 *         self-heal silently (session reset in place).
 */
import { backupId, backupChunkRange, backupLibrary, backupLibraryId } from './backup-id.ts';
import { openChunkSession, takeChunk } from './backup-chunk.ts';
import { Elysia, t } from 'elysia';
import { setAppleRenderedPath } from '../db/sqlite/repos/backup.repo.ts';
import { uploadSessions } from '../backup/upload-session.ts';
import { isSafeFilenamePart, containedJoin } from '../backup/path-safety.ts';
import { child as childLogger } from '../log.ts';
// Mirror-aware drop-in: the rendered-companion publish replicates to the
// library's backup root(s). `link` and `copyFile` are both mirror-aware.
import fs from '../fs/mirrored.ts';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

const log = childLogger('backup-rendered');

/** Move src to dst atomically. Fails with EEXIST when dst already exists —
 * this is the final-path collision guard for rendered uploads.
 *
 * The cross-device cloud-id check in `openOrResume` is intentionally
 * non-atomic (see the comment block there). If two devices on the same iCloud
 * library both race past that check and finish their uploads, naively renaming
 * each tmp file into place would silently let the second mover overwrite the
 * first's companion file. Refusing to clobber at the move step closes that
 * window: the caller catches EEXIST and treats it as "the file is already
 * there" — exactly what we want, since the rendered companion is per-photo,
 * not per-device, and both devices would produce the same bytes for the same
 * iCloud asset.
 *
 * Same-filesystem path uses `link(2)` (POSIX-atomic with EEXIST semantics).
 * Cross-filesystem fallback uses `open(O_CREAT | O_EXCL)` via `fs.open(dst, "wx")`
 * — the kernel-level analog that's atomic w.r.t. concurrent creates. */
async function atomicMove(src: string, dst: string): Promise<void> {
  try {
    await fs.link(src, dst);
    await fs.unlink(src);
    return;
  } catch (e: any) {
    if (e?.code === 'EEXIST') throw e;
    if (e?.code !== 'EXDEV') throw e;
  }
  // Cross-filesystem: copy with COPYFILE_EXCL (O_CREAT | O_EXCL) so a
  // concurrent create still surfaces EEXIST atomically, then drop the tmp.
  // Going through the mirror-aware `copyFile` (rather than a raw FileHandle
  // write) is what lets the rendered companion replicate to the backup root.
  await fs.copyFile(src, dst, fsConstants.COPYFILE_EXCL);
  await fs.unlink(src);
}

/**
 * Validate that a relative path is safe: no ".." segments, no leading slash,
 * no backslash, no empty segments.
 */
function isSafeRelPath(relPath: string): boolean {
  if (!relPath || relPath.length === 0 || relPath.length > 2048) return false;
  if (relPath.startsWith('/') || relPath.startsWith('\\')) return false;
  const parts = relPath.split(/[/\\]/);
  for (const part of parts) {
    if (part === '..' || part === '.') return false;
    if (part.length === 0) return false;
  }
  return true;
}

/**
 * Compute the rendered companion path from the original rel-path and an
 * optional explicit extension.
 *
 * e.g. "2024/Tokyo/03-15/IMG.HEIC" → "2024/Tokyo/03-15/IMG.rendered.HEIC"
 *      with ext ".JPEG"             → "2024/Tokyo/03-15/IMG.rendered.JPEG"
 *      with suffixOverride "mov"    → "2024/Tokyo/03-15/IMG.mov"
 *
 * @param suffixOverride When present, the file is named `<base>.<suffixOverride>`
 *   instead of `<base>.rendered.<ext>`. Used by the Live Photo .mov path so the
 *   twin lands without the `.rendered.` infix.
 */
function renderedRelPath(originalRelPath: string, ext?: string, suffixOverride?: string): string {
  const base = originalRelPath.slice(
    0,
    originalRelPath.length - path.extname(originalRelPath).length,
  );
  if (suffixOverride) {
    const normalSuffix = suffixOverride.startsWith('.') ? suffixOverride.slice(1) : suffixOverride;
    return `${base}.${normalSuffix}`;
  }
  const extToUse = ext ?? path.extname(originalRelPath);
  const normalExt = extToUse.startsWith('.') ? extToUse : `.${extToUse}`;
  return `${base}.rendered${normalExt}`;
}

/** Every header this route reads, validated, or the 400 to answer instead. */
interface RenderedHeaders {
  deviceId: string;
  phid: string;
  originalRelPath: string;
  totalBytesRaw: string;
  range: string;
  mapleIdHeader: string | undefined;
  filenameExt: string | undefined;
  suffixOverride: string | undefined;
  phCloudId: string | undefined;
}

/**
 * Reads and checks the request's headers before anything is opened or written.
 *
 * Kept out of the handler because it is the half of this route that has no
 * order to it — every check here is independent of every other, and none of
 * them touches the database or the disk. What is left in the handler is the
 * sequence that does.
 */
function renderedHeaders(headers: Record<string, string | undefined>): Response | RenderedHeaders {
  const deviceId = headers['x-maple-device-id'];
  const phid = headers['x-maple-phasset-id'];
  const originalRelPath = headers['x-maple-target-rel-path'];
  const totalBytesRaw = headers['x-maple-total-bytes'];
  const range = headers['content-range'];
  if (!deviceId || !phid || !originalRelPath || !totalBytesRaw || !range) {
    return badRequest('missing required headers');
  }

  // Path-traversal guard.
  if (!isSafeRelPath(originalRelPath)) return badRequest('unsafe X-Maple-Target-Rel-Path');

  const filenameExt = headers['x-maple-filename-ext'];
  const suffixOverride = headers['x-maple-suffix-override'];
  const unsafePart = unsafeFilenamePart(filenameExt, suffixOverride);
  if (unsafePart !== null) return badRequest(unsafePart);

  const mapleIdHeader = backupId(headers['x-maple-maple-id'], 'x-maple-maple-id');
  if (mapleIdHeader instanceof Response) return mapleIdHeader;

  return {
    deviceId,
    phid,
    originalRelPath,
    totalBytesRaw,
    range,
    mapleIdHeader,
    filenameExt,
    suffixOverride,
    // Optional iCloud cloud id — when two devices on the same iCloud library
    // both try to upload the rendered companion for one photo, `openOrResume`
    // uses this to detect the collision and answer 423 rather than letting the
    // second device race the move at the end of the upload.
    phCloudId: headers['x-maple-phasset-cloud-id'],
  };
}

/**
 * Names the first optional filename part that is not safe to splice into a
 * path, or null when both are.
 *
 * Both are spliced into the write path, so they get their own allowlist on top
 * of the rel-path guard — a `..` or a separator in either one would escape the
 * library root (#854).
 */
function unsafeFilenamePart(ext: string | undefined, suffix: string | undefined): string | null {
  if (ext !== undefined && !isSafeFilenamePart(ext)) return 'unsafe X-Maple-Filename-Ext';
  if (suffix !== undefined && !isSafeFilenamePart(suffix)) {
    return 'unsafe X-Maple-Suffix-Override';
  }
  return null;
}

/**
 * Moves the assembled companion into the library.
 *
 * `EEXIST` is success, not a failure: another device won the race past the
 * cloud-id check and its copy is already at the canonical path. The asset
 * update that follows either already points there or is about to, so the loser
 * drops its temporary copy and reports the same result.
 */
async function placeRenderedFile(
  tmpFile: string,
  libraryRoot: string,
  relPath: string,
): Promise<Response | string> {
  // Containment backstop: never write outside the library root, even if an
  // upstream guard was missed (#854).
  const finalPath = containedJoin(libraryRoot, relPath);
  if (!finalPath) return badRequest('resolved path escapes library root');
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  try {
    await atomicMove(tmpFile, finalPath);
  } catch (e: unknown) {
    if ((e as { code?: unknown } | null)?.code !== 'EEXIST') throw e;
    await fs.unlink(tmpFile).catch(() => {});
  }
  return finalPath;
}

/**
 * The cloud id a rendered session claims, which is the photo's with a suffix.
 *
 * The suffix is what namespaces rendered sessions apart from the original-asset
 * sessions for the same photo. Without it a rendered upload from device B sees
 * device A's ORIGINAL session as a busy peer and backs off for nothing.
 */
function renderedSessionCloudId(phCloudId: string | undefined): string | undefined {
  return phCloudId === undefined ? undefined : `${phCloudId}::rendered`;
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

export const backupRenderedRoutes = new Elysia().post(
  '/api/libraries/:libraryId/backup/rendered',
  async ({ params, headers, body, set }) => {
    const libraryId = backupLibraryId(params.libraryId);
    if (libraryId instanceof Response) return libraryId;

    const request = renderedHeaders(headers);
    if (request instanceof Response) return request;
    const { deviceId, phid, originalRelPath, totalBytesRaw, range } = request;
    const { mapleIdHeader, filenameExt, suffixOverride, phCloudId } = request;

    const chunk = backupChunkRange(totalBytesRaw, range, mapleIdHeader);
    if (chunk instanceof Response) return chunk;
    const { start, end, rangeTotal, totalBytes } = chunk;

    // Check library exists.
    const folder = await backupLibrary(libraryId);
    if (folder instanceof Response) return folder;

    // Compute target rel-path for the rendered companion.
    const targetRelPath = renderedRelPath(originalRelPath, filenameExt, suffixOverride);

    // Use synthetic phid so rendered sessions don't collide with original sessions.
    const syntheticPhid = `${phid}::rendered`;

    const renderedCloudId = renderedSessionCloudId(phCloudId);

    const opened = await openChunkSession({
      libraryId,
      deviceId,
      phassetLocalId: syntheticPhid,
      totalBytes,
      chunkSize: end - start + 1,
      targetRelPath,
      phassetCloudId: renderedCloudId,
    });
    if (opened instanceof Response) return opened;
    const { session, didReset, alreadyComplete } = opened;

    // Same short-circuit as backup-ingest: when the rendered companion
    // already finished server-side, return 200 with the stored target path
    // so the client doesn't burn retry slots on an upload that's already
    // landed on disk.
    if (alreadyComplete) {
      log.debug(
        { phid, targetRelPath: session.target_rel_path },
        'rendered ingest short-circuit (already complete)',
      );
      set.status = 200;
      return { target_rel_path: session.target_rel_path };
    }

    const resolvedTargetRelPath = session.target_rel_path;

    const chunkResult = await takeChunk({
      session,
      didReset,
      start,
      end,
      rangeTotal,
      body,
      mapleId: mapleIdHeader,
    });
    if (chunkResult instanceof Response) return chunkResult;
    // The upload is assembled and `mapleId` is known to be present: every
    // earlier return above is the chunk protocol's, not this route's.
    const { tmpFile, mapleId } = chunkResult;

    // -----------------------------------------------------------------------
    // Final chunk — move assembled file into place + update AssetDoc.
    // -----------------------------------------------------------------------

    const placed = await placeRenderedFile(tmpFile, folder.path, resolvedTargetRelPath);
    if (placed instanceof Response) return placed;
    await uploadSessions.complete({ sessionId: session._id, mapleId });

    // Persist apple_rendered_path on the matching asset. Post
    // drop-abs-path-2026-05-21 the per-library pointer is the asset's
    // locations, so the update is scoped by a location in this library plus
    // the content-addressed `maple_id`.
    await setAppleRenderedPath(libraryId, mapleId, resolvedTargetRelPath);

    log.debug({ phid, targetRelPath: resolvedTargetRelPath, mapleId }, 'rendered ingest complete');
    set.status = 200;
    return { target_rel_path: resolvedTargetRelPath };
  },
  {
    params: t.Object({ libraryId: t.String() }),
    body: t.Any(),
  },
);
