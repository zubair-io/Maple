/**
 * POST /api/libraries/:libraryId/backup/ingest
 *
 * Chunked, resumable upload from a PhotoKit-backed device. Headers carry the
 * resume key (X-Maple-Device-Id + X-Maple-Phasset-Id) and the asset metadata
 * needed to compute the destination path (capture date, optional GPS,
 * filename). Body is the raw bytes for the current chunk; Content-Range
 * declares the offset.
 *
 *   202 — chunk accepted, more expected. Body: { next_offset: number }
 *   200 — final chunk accepted, asset created/updated. Body: { maple_id, target_rel_path }
 *   400 — missing/invalid headers, bad Content-Range
 *   404 — library id not found
 *   409 — resume offset mismatch. Body: { expected_offset: number }
 *         Or a pending permanent purge owns the photo: nothing is linked or
 *         published and the session restarts. Body: { error, code: 'purge_admitted' }
 *   423 — another device is actively uploading the same iCloud photo.
 *         Body: { retry_after_seconds: number } — client should wait at
 *         least that long before retrying. Same-key metadata mismatches
 *         (total_bytes or target_rel_path changed between attempts) are
 *         handled silently — the session is reset in place rather than
 *         returning 409.
 *
 * Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §20.
 */
import { backupId, backupChunkRange, backupLibrary, backupLibraryId } from './backup-id.ts';
import { openChunkSession, takeChunk } from './backup-chunk.ts';
import { Elysia, t } from 'elysia';
import {
  appendBackupLocation,
  findIngestDedupTarget,
  insertBackupAsset,
  isLocationOwnedByOtherAsset,
  linkPhasset,
  type PhassetLink,
} from '../db/repos/backup.repo.ts';
import type { ObjectId } from '../db/object-id.ts';
import { uploadSessions } from '../backup/upload-session.ts';
import { formatBackupPath } from '../backup/path-formatter.ts';
import { containedJoin } from '../backup/path-safety.ts';
import { hasLegacyBackupEdit } from '../fs/legacy-backup-sidecar.ts';
import { filesIdentical, firstFreeSiblingPath, moveNoClobber } from '../backup/fs-util.ts';
import { revertCreated, type RelocatePublication } from '../fs/relocate-publish.ts';
import { resolveBackupLocation } from '../backup/ingest-geocode.ts';
import { isScreenshotFilename } from '../indexer/screenshot.ts';
import { backupSessionsRepo } from '../db/backup-sessions.repo.ts';
import { child as childLogger } from '../log.ts';
import fs from 'node:fs/promises';
import path from 'node:path';

const log = childLogger('backup-ingest');

async function hasFileOnDisk(libraryRoot: string, relPath: string): Promise<boolean> {
  const fullPath = containedJoin(libraryRoot, relPath);
  if (!fullPath) return false;
  try {
    const stat = await fs.stat(fullPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function removeTmpQuietly(tmpFile: string): Promise<void> {
  try {
    await fs.unlink(tmpFile);
  } catch {
    /* already gone */
  }
}

async function isOccupiedOnDisk(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath);
    return true;
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === 'ENOENT') return false;
    throw e;
  }
}

/** A moved photo's old-name edit (#5063) left with no photo beside it: the
 * canonical-sidecars migration would hand it to whatever lands here. An
 * edit beside identical bytes is that photo's own, so recovery still adopts. */
async function holdsStrandedLegacyEdit(absPath: string): Promise<boolean> {
  return (await hasLegacyBackupEdit(absPath)) && !(await isOccupiedOnDisk(absPath));
}

/** Move the upload to `finalPath` unless something is there. The upload's own
 * inode is read before the move: a hard link keeps it, so a file another writer
 * swaps in afterwards is never recorded as this upload's (a cross-device copy
 * records nothing, so nothing is later withdrawn). Null when the name is taken. */
async function claimNoClobber(
  tmpFile: string,
  finalPath: string,
): Promise<{ published?: RelocatePublication } | null> {
  const staged = await fs.lstat(tmpFile);
  if (!(await moveNoClobber(tmpFile, finalPath))) return null;
  const landed = await fs.lstat(finalPath).catch(() => null);
  return landed?.dev === staged.dev && landed.ino === staged.ino
    ? { published: { path: finalPath, dev: staged.dev, ino: staged.ino } }
    : {};
}

/**
 * Place the assembled `tmpFile` into `libraryRoot` starting from `baseRelPath`
 * without ever clobbering or adopting an unrelated file (#4700):
 *
 *   (a) If the candidate path is already on disk with byte-identical content
 *       and is not claimed in `asset_locations` by another asset, adopt it and
 *       remove `tmpFile`.
 *   (b) If the candidate path is occupied on disk by different bytes (even of
 *       the same size) or claimed in `asset_locations` by another asset,
 *       disambiguate to the next free sibling (`-1`, `-2`, …).
 *   (c) Otherwise claim the path with `moveNoClobber`, looping on `EEXIST`.
 */
async function placeUploadOnDisk(args: {
  libraryId: ObjectId;
  libraryRoot: string;
  baseRelPath: string;
  tmpFile: string;
  phid: string;
  mapleId: string;
  assetId?: ObjectId;
}): Promise<{ relPath: string; published?: RelocatePublication } | null> {
  let resolvedRelPath = args.baseRelPath;
  const containedBase = containedJoin(args.libraryRoot, resolvedRelPath);
  if (!containedBase) return null;

  const isClaimedByOther = async (relPath: string) =>
    (await isLocationOwnedByOtherAsset(args.libraryId, relPath, args.assetId)) ||
    (await holdsStrandedLegacyEdit(path.join(args.libraryRoot, ...relPath.split('/'))));

  let finalPath = containedBase;
  for (let attempt = 0; attempt <= 10_000; attempt++) {
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    const claimedByOther = await isClaimedByOther(resolvedRelPath);
    const occupied = await isOccupiedOnDisk(finalPath);

    if (!claimedByOther && !occupied) {
      const claimed = await claimNoClobber(args.tmpFile, finalPath);
      if (claimed) return { relPath: resolvedRelPath, ...claimed };
      continue;
    }

    if (!claimedByOther && (await filesIdentical(finalPath, args.tmpFile))) {
      await removeTmpQuietly(args.tmpFile);
      log.debug(
        {
          phid: args.phid,
          mapleId: args.mapleId,
          targetRelPath: resolvedRelPath,
        },
        'ingest recovery (matching bytes already on disk) — adopting',
      );
      return { relPath: resolvedRelPath };
    }

    const free = await firstFreeSiblingPath(args.libraryRoot, args.baseRelPath, isClaimedByOther);
    log.warn(
      {
        phid: args.phid,
        mapleId: args.mapleId,
        collidedRelPath: resolvedRelPath,
        resolvedRelPath: free.relPath,
      },
      'ingest path collision — disambiguating',
    );
    resolvedRelPath = free.relPath;
    finalPath = free.absPath;
  }
  throw new Error(`could not place upload for ${args.baseRelPath} after 10000 attempts`);
}

export const backupIngestRoutes = new Elysia().post(
  '/api/libraries/:libraryId/backup/ingest',
  // fallow-ignore-next-line complexity
  async (ctx) => {
    const { params, headers, body, set } = ctx;
    const auth = (ctx as { auth?: { user?: { sub?: string } } }).auth;
    const ownerId = auth?.user?.sub && auth.user.sub !== 'image-capability' ? auth.user.sub : null;
    const libraryId = backupLibraryId(params.libraryId);
    if (libraryId instanceof Response) return libraryId;

    // Check library exists.
    const folder = await backupLibrary(libraryId);
    if (folder instanceof Response) return folder;

    // Extract + validate required headers.
    const deviceId = headers['x-maple-device-id'];
    const phid = headers['x-maple-phasset-id'];
    // Stable across every device on the same iCloud Photos account. Optional
    // — non-iCloud library users won't have a cloud id, and the merge logic
    // falls back to phasset_local_id matching in that case.
    const phCloudId = headers['x-maple-phasset-cloud-id'];
    const captureRaw = headers['x-maple-capture-date'];
    const filename = headers['x-maple-filename'];
    const totalBytesRaw = headers['x-maple-total-bytes'];
    const latRaw = headers['x-maple-lat'];
    const lonRaw = headers['x-maple-lon'];
    const mapleIdHeader = backupId(headers['x-maple-maple-id'], 'x-maple-maple-id');
    if (mapleIdHeader instanceof Response) return mapleIdHeader;
    const range = headers['content-range'];

    if (!deviceId || !phid || !captureRaw || !filename || !totalBytesRaw || !range) {
      set.status = 400;
      return { error: 'missing required headers' };
    }

    const chunk = backupChunkRange(totalBytesRaw, range, mapleIdHeader);
    if (chunk instanceof Response) return chunk;
    const { start, end, rangeTotal, totalBytes } = chunk;

    // Parse and validate capture date.
    const captureDate = new Date(captureRaw);
    if (isNaN(captureDate.getTime())) {
      set.status = 400;
      return { error: 'invalid X-Maple-Capture-Date' };
    }

    // Resolve GPS → location segments (<State|Country>/<Town/City||Place>).
    // Warm-cache hit first, then a live Nominatim lookup when configured (so a
    // cold cache on a fresh bulk import still gets a geocoded path). Any
    // miss/failure is soft — `[]` falls the path back to the date-only layout,
    // and the geo-layout migration relocates it once the place is known.
    const lat = parseFloat(latRaw ?? 'NaN');
    const lon = parseFloat(lonRaw ?? 'NaN');
    const location = await resolveBackupLocation(lat, lon);

    // A screenshot is filed under `<year>/Screenshot`, not by location/date.
    // The only signal available this early (no EXIF parsed yet) is the
    // device-reported filename, so reuse the same heuristic the EXIF stage
    // seeds `is_screenshot` with; the describe stage + the screenshot
    // migration catch anything the name doesn't reveal.
    const isScreenshot = isScreenshotFilename(filename);

    // Compute the destination relative path.
    let targetRelPath: string;
    try {
      targetRelPath = formatBackupPath({
        captureDate,
        location,
        filename,
        isScreenshot,
      });
    } catch (e: any) {
      set.status = 400;
      return { error: e?.message ?? 'invalid filename' };
    }

    const opened = await openChunkSession({
      libraryId,
      deviceId,
      phassetLocalId: phid,
      totalBytes,
      chunkSize: end - start + 1,
      targetRelPath,
      phassetCloudId: phCloudId,
    });
    if (opened instanceof Response) return opened;
    let { didReset } = opened;
    const { session, alreadyComplete } = opened;

    // Short-circuit when the upload already finished server-side and the
    // stored copy is still live on disk (#4700). The device is retrying
    // because something AFTER the original ingest (sidecar / rendered / live
    // video) failed and re-enqueued the task — re-uploading the same bytes is
    // wasted work, and the client's downstream steps (sidecar PUT, rendered
    // POST) only need `maple_id` + `target_rel_path` to proceed. If the asset
    // was marked missing or its file vanished since completion, reopen the
    // session and accept the repair upload instead.
    if (alreadyComplete) {
      const completedTarget = session.maple_id
        ? await findIngestDedupTarget({
            mapleId: session.maple_id,
            libraryId,
            deviceId,
            phassetLocalId: phid,
          })
        : null;
      if (completedTarget?.purgeAdmitted) {
        set.status = 409;
        return { error: 'asset has a durable purge intent' };
      }
      const completedRelPath = completedTarget?.liveRelPathInLibrary;
      const stillPresent =
        completedRelPath != null && (await hasFileOnDisk(folder.path, completedRelPath));

      if (stillPresent) {
        log.debug(
          {
            phid,
            mapleId: session.maple_id,
            targetRelPath: completedRelPath,
          },
          'ingest short-circuit (already complete)',
        );
        set.status = 200;
        return {
          maple_id: session.maple_id,
          // Hand back where the bytes actually live now: the current live
          // location in this library (which follows relocations/refiles) or
          // the disambiguated session path. Companions (sidecar / rendered)
          // must be written next to the real file, not the path that collided.
          target_rel_path: completedRelPath,
        };
      }

      await uploadSessions.resetForRestart(session._id);
      session.state = 'open';
      session.received_bytes = 0;
      didReset = true;
    }

    // Use the stored target_rel_path as the source of truth (not the freshly
    // computed value) — prevents a client from redirecting an in-progress
    // upload by sending different metadata on resume. May be reassigned below
    // if a genuinely different asset already occupies the computed path.
    let resolvedTargetRelPath = session.target_rel_path;

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
    // Final chunk — dedup check first, then move assembled file into place.
    // -----------------------------------------------------------------------

    // 1. Dedup lookup BEFORE any filesystem operations. It answers three
    //    things at once: which asset already carries this content, whether
    //    this library holds a live copy of it, and whether this device's
    //    PHAsset is already linked to it.
    const existing = await findIngestDedupTarget({
      mapleId,
      libraryId,
      deviceId,
      phassetLocalId: phid,
    });
    const link: PhassetLink = {
      device_id: deviceId,
      phasset_local_id: phid,
      first_seen: new Date(),
      ...(phCloudId ? { phasset_cloud_id: phCloudId } : {}),
    };

    // A purge admitted after the lookup is caught by the guarded write (#4913).
    const refusePurged = async () => {
      await removeTmpQuietly(tmpFile);
      await uploadSessions.resetForRestart(session._id);
      set.status = 409;
      return { error: 'asset has a durable purge intent', code: 'purge_admitted' };
    };

    if (existing) {
      if (existing.purgeAdmitted) return refusePurged();
      // Same content already stored somewhere. Whether we can pure-dedup
      // (no second copy on disk) depends on which library that copy lives in
      // and whether the file is actually still on disk (#4700).
      //
      // maple_id is a GLOBAL content hash — not scoped to a library. The
      // matched row may carry locations only for some OTHER library (e.g. the
      // photo was discovered by a folder scan, or backed up to a different
      // library first). The downstream sidecar / rendered routes look the
      // asset up scoped to THIS library, so if we link-and-dedup against an
      // other-library row without giving THIS library a location, those steps
      // 404 — which is the backup failure this branch caused. The invariant:
      // backing a photo up to library Y must leave a usable location
      // referencing Y.
      const liveRelPath = existing.liveRelPathInLibrary;
      const liveOnDisk = liveRelPath !== null && (await hasFileOnDisk(folder.path, liveRelPath));

      if (liveRelPath !== null && liveOnDisk) {
        // Content already on disk in THIS library — true dedup. Drop the tmp
        // bytes; the canonical copy already lives at this library's location.
        // Linking this device to the existing row is idempotent on retry.
        if (!existing.alreadyLinked) {
          if (!(await linkPhasset(existing.id, link))) return refusePurged();
        }
        try {
          await fs.unlink(tmpFile);
        } catch {
          /* already gone */
        }
        // The rel path tells the device where the canonical copy lives (used
        // to route subsequent change-feed updates).
        await uploadSessions.complete({
          sessionId: session._id,
          mapleId,
          resolvedRelPath: liveRelPath,
        });
        await backupSessionsRepo.upsertProgress({
          libraryId,
          deviceId,
          uploadedDelta: 1,
          failedDelta: 0,
        });
        log.debug({ phid, mapleId, dedup: true }, 'ingest complete (dedup, same library)');
        set.status = 200;
        return {
          maple_id: mapleId,
          target_rel_path: liveRelPath,
        };
      }

      // Content exists, but either NOT in this library or its copy in this
      // library is missing on disk (#4700) — materialize a copy here so this
      // library has a live file and location (and the folder-scoped sidecar /
      // rendered lookups succeed). When restoring a missing/vanished location
      // in this library, prefer that location's path so `appendBackupLocation`
      // re-activates the existing row in place, while `placeUploadOnDisk`
      // verifies any on-disk occupant byte-for-byte and disambiguates to a
      // sibling if an unrelated file now sits at that path.
      const candidateRelPath =
        liveRelPath ?? existing.missingRelPathInLibrary ?? resolvedTargetRelPath;
      const placed = await placeUploadOnDisk({
        libraryId,
        libraryRoot: folder.path,
        baseRelPath: candidateRelPath,
        tmpFile,
        phid,
        mapleId,
        assetId: existing.id,
      });
      if (!placed) {
        set.status = 400;
        return { error: 'resolved path escapes library root' };
      }
      resolvedTargetRelPath = placed.relPath;

      const appended = await appendBackupLocation(existing.id, {
        relPath: resolvedTargetRelPath,
        libraryId,
        link: existing.alreadyLinked ? null : link,
        ownerId,
        replacedRelPath: liveRelPath ?? existing.missingRelPathInLibrary,
      });
      if (!appended) {
        if (placed.published) await revertCreated([placed.published]);
        return refusePurged();
      }

      await uploadSessions.complete({
        sessionId: session._id,
        mapleId,
        resolvedRelPath: resolvedTargetRelPath,
      });
      await backupSessionsRepo.upsertProgress({
        libraryId,
        deviceId,
        uploadedDelta: 1,
        failedDelta: 0,
      });
      log.debug(
        {
          phid,
          mapleId,
          dedup: true,
          crossLibrary: true,
          targetRelPath: resolvedTargetRelPath,
        },
        'ingest complete (dedup, materialized in target library)',
      );
      set.status = 200;
      return { maple_id: mapleId, target_rel_path: resolvedTargetRelPath };
    }

    // 2. No existing row — place the assembled tmp file at its destination,
    //    adopting byte-identical recovery files or disambiguating collisions.
    const placed = await placeUploadOnDisk({
      libraryId,
      libraryRoot: folder.path,
      baseRelPath: resolvedTargetRelPath,
      tmpFile,
      phid,
      mapleId,
    });
    if (!placed) {
      set.status = 400;
      return { error: 'resolved path escapes library root' };
    }
    resolvedTargetRelPath = placed.relPath;

    await uploadSessions.complete({
      sessionId: session._id,
      mapleId,
      resolvedRelPath: resolvedTargetRelPath,
    });

    await insertBackupAsset({
      relPath: resolvedTargetRelPath,
      libraryId,
      totalBytes,
      mapleId,
      isScreenshot,
      link,
      ownerId,
    });

    // Update per-device backup progress summary.
    await backupSessionsRepo.upsertProgress({
      libraryId,
      deviceId,
      uploadedDelta: 1,
      failedDelta: 0,
    });

    log.debug({ phid, targetRelPath: resolvedTargetRelPath, mapleId }, 'ingest complete');
    set.status = 200;
    return { maple_id: mapleId, target_rel_path: resolvedTargetRelPath };
  },
  {
    params: t.Object({ libraryId: t.String() }),
    body: t.Any(),
  },
);
