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
 *                             .mov path to skip the `.rendered.` infix; that
 *                             upload gets its own session and is recorded as
 *                             the asset's apple_live_video_path rather than
 *                             its apple_rendered_path.
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
import {
  backupChunkRange,
  backupId,
  backupLibrary,
  backupLibraryId,
  isSafeRelPath,
} from './backup-id.ts';
import { openChunkSession, takeChunk } from './backup-chunk.ts';
import { Elysia, t } from 'elysia';
import { setAppleCompanionPath } from '../db/repos/backup.repo.ts';
import { assetOwnsRelPath } from '../db/repos/assets.location-owner.ts';
import { filesIdentical, moveNoClobber } from '../backup/fs-util.ts';
import type { ObjectId } from '../db/object-id.ts';
import { uploadSessions } from '../backup/upload-session.ts';
import { isSafeFilenamePart, containedJoin } from '../backup/path-safety.ts';
import { child as childLogger } from '../log.ts';
// Mirror-aware drop-in: the rendered-companion publish replicates to the
// library's backup root(s). `link` and `copyFile` are both mirror-aware.
import fs from '../fs/mirrored.ts';
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
  if (!(await moveNoClobber(src, dst))) {
    throw Object.assign(new Error(`Rendered destination is occupied: ${dst}`), { code: 'EEXIST' });
  }
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

/** `relPath` itself, then `<stem>-1<ext>`, `<stem>-2<ext>`, … in its folder. */
function companionCandidate(relPath: string, attempt: number): string {
  if (attempt === 0) return relPath;
  const dir = path.posix.dirname(relPath);
  const ext = path.posix.extname(relPath);
  const name = `${path.posix.basename(relPath, ext)}-${attempt}${ext}`;
  return dir === '.' ? name : `${dir}/${name}`;
}

/**
 * Moves the assembled companion into the library and returns the rel path it
 * actually landed at.
 *
 * Walks the canonical name and then its suffixed siblings. A name an asset
 * owns is skipped. A free name is claimed without clobbering. An occupied name
 * is adopted only when it already holds these exact bytes — another device
 * placed this same companion there first, including at a suffix, so a second
 * device reuses it instead of leaking another copy. Anything else — an
 * unrelated file, or another asset's original under a case alias — would be
 * recorded as this photo's companion and deleted with it on a Trash purge
 * (#4695), so the walk moves on.
 */
async function placeRenderedFile(
  tmpFile: string,
  libraryId: ObjectId,
  libraryRoot: string,
  relPath: string,
): Promise<Response | string> {
  // Containment backstop: never write outside the library root, even if an
  // upstream guard was missed (#854).
  const finalPath = containedJoin(libraryRoot, relPath);
  if (!finalPath) return badRequest('resolved path escapes library root');
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  for (let attempt = 0; attempt <= 9999; attempt++) {
    const candidate = companionCandidate(relPath, attempt);
    if (await assetOwnsRelPath(libraryId, candidate)) continue;
    const absPath = path.join(libraryRoot, ...candidate.split('/'));
    try {
      await atomicMove(tmpFile, absPath);
    } catch (e: unknown) {
      if ((e as { code?: unknown } | null)?.code !== 'EEXIST') throw e;
      if (!(await filesIdentical(tmpFile, absPath))) continue;
      await fs.unlink(tmpFile).catch(() => {});
    }
    if (candidate !== relPath) {
      log.warn({ requested: relPath, placed: candidate }, 'rendered companion target occupied');
    }
    return candidate;
  }
  throw new Error(`no free name for rendered companion ${relPath}`);
}

/**
 * The cloud id a companion session claims, which is the photo's with a suffix.
 *
 * The suffix is what namespaces companion sessions apart from the original-asset
 * sessions for the same photo, and from each other. Without it a rendered upload
 * from device B sees device A's ORIGINAL session as a busy peer and backs off
 * for nothing.
 */
function companionSessionCloudId(
  phCloudId: string | undefined,
  companion: string,
): string | undefined {
  return phCloudId === undefined ? undefined : `${phCloudId}::${companion}`;
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

    // A Live Photo's .mov and its Apple-rendered edit are separate uploads of
    // the same photo, so each gets its own session, apart from the original's.
    const companion = suffixOverride === undefined ? 'rendered' : 'live';
    const syntheticPhid = `${phid}::${companion}`;

    const renderedCloudId = companionSessionCloudId(phCloudId, companion);

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
      // A disambiguated upload completed under its sibling name; hand that
      // back, not the occupied path the device asked for.
      return { target_rel_path: session.resolved_rel_path ?? session.target_rel_path };
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

    const placed = await placeRenderedFile(tmpFile, libraryId, folder.path, resolvedTargetRelPath);
    if (placed instanceof Response) return placed;
    await uploadSessions.complete({ sessionId: session._id, mapleId, resolvedRelPath: placed });

    // Record the companion on the matching asset. Post
    // drop-abs-path-2026-05-21 the per-library pointer is the asset's
    // locations, so the update is scoped by a location in this library plus
    // the content-addressed `maple_id`.
    const slot = companion === 'live' ? 'apple_live_video_path' : 'apple_rendered_path';
    await setAppleCompanionPath(libraryId, mapleId, slot, placed);

    log.debug({ phid, targetRelPath: placed, mapleId }, 'rendered ingest complete');
    set.status = 200;
    return { target_rel_path: placed };
  },
  {
    params: t.Object({ libraryId: t.String() }),
    body: t.Any(),
  },
);
