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
 *   423 — another device is actively uploading the same iCloud photo.
 *         Body: { retry_after_seconds: number } — client should wait at
 *         least that long before retrying. Same-key metadata mismatches
 *         (total_bytes or target_rel_path changed between attempts) are
 *         handled silently — the session is reset in place rather than
 *         returning 409.
 *
 * Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §20.
 */
import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { assetsCollection, foldersCollection, geocodeCacheCollection } from '../db/client.ts';
import { uploadSessions, BusyElsewhereError } from '../backup/upload-session.ts';
import { formatBackupPath } from '../backup/path-formatter.ts';
import { backupSessionsRepo } from '../db/backup-sessions.repo.ts';
import { quantizedKey } from '../enrichment/coordinate-cache.ts';
import { child as childLogger } from '../log.ts';
import fs from 'node:fs/promises';
import path from 'node:path';

const log = childLogger('backup-ingest');
const CHUNK_DIR = process.env.MAPLE_BACKUP_TMP ?? '/tmp/maple-backup-chunks';

/** Move src to dst atomically. Falls back to copy+unlink on EXDEV (cross-device). */
async function atomicMove(src: string, dst: string): Promise<void> {
  try {
    await fs.rename(src, dst);
  } catch (e: any) {
    if (e?.code === 'EXDEV') {
      await fs.copyFile(src, dst);
      await fs.unlink(src);
    } else {
      throw e;
    }
  }
}

/** Resolve a location name from the geocode cache. Returns null on miss. */
async function resolveLocation(lat: number, lon: number): Promise<string | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const coll = await geocodeCacheCollection();
  const row = await coll.findOne({ _id: quantizedKey(lat, lon) });
  if (!row) return null;
  return row.place.pois[0]?.name ?? row.place.rollups?.locality ?? null;
}

export const backupIngestRoutes = new Elysia().post(
  '/api/libraries/:libraryId/backup/ingest',
  async ({ params, headers, body, set }) => {
    // Validate library id.
    let libraryId: ObjectId;
    try {
      libraryId = new ObjectId(params.libraryId);
    } catch {
      set.status = 400;
      return { error: 'invalid library id' };
    }

    // Check library exists.
    const folder = await (await foldersCollection()).findOne({ _id: libraryId });
    if (!folder) {
      set.status = 404;
      return { error: 'library not found' };
    }

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
    const mapleId = headers['x-maple-maple-id'];
    const range = headers['content-range'];

    if (!deviceId || !phid || !captureRaw || !filename || !totalBytesRaw || !range) {
      set.status = 400;
      return { error: 'missing required headers' };
    }

    const totalBytes = parseInt(totalBytesRaw, 10);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
      set.status = 400;
      return { error: 'invalid X-Maple-Total-Bytes' };
    }

    // Parse Content-Range: bytes <start>-<end>/<total>
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!m) {
      set.status = 400;
      return { error: 'invalid Content-Range' };
    }
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    const rangeTotal = parseInt(m[3], 10);
    if (end < start) {
      set.status = 400;
      return { error: 'invalid Content-Range: end must be >= start' };
    }
    if (end >= rangeTotal) {
      set.status = 400;
      return { error: 'invalid Content-Range: end must be < total' };
    }
    if (rangeTotal !== totalBytes) {
      set.status = 400;
      return { error: 'Content-Range total mismatch with X-Maple-Total-Bytes' };
    }

    // Parse and validate capture date.
    const captureDate = new Date(captureRaw);
    if (isNaN(captureDate.getTime())) {
      set.status = 400;
      return { error: 'invalid X-Maple-Capture-Date' };
    }

    // Resolve GPS → location name (cache miss is a soft failure — path falls back to date-only layout).
    const lat = parseFloat(latRaw ?? 'NaN');
    const lon = parseFloat(lonRaw ?? 'NaN');
    const location = await resolveLocation(lat, lon);

    // Compute the destination relative path.
    let targetRelPath: string;
    try {
      targetRelPath = formatBackupPath({ captureDate, location, filename });
    } catch (e: any) {
      set.status = 400;
      return { error: e?.message ?? 'invalid filename' };
    }

    // Open or resume the upload session.
    let session;
    let didReset = false;
    let alreadyComplete = false;
    try {
      const r = await uploadSessions.openOrResume({
        libraryId,
        deviceId,
        phassetLocalId: phid,
        totalBytes,
        chunkSize: end - start + 1,
        targetRelPath,
        phassetCloudId: phCloudId,
      });
      session = r.session;
      didReset = r.reset;
      alreadyComplete = r.alreadyComplete;
    } catch (e: any) {
      if (e instanceof BusyElsewhereError) {
        set.status = 423;
        return {
          error: e.message,
          retry_after_seconds: e.retryAfterSeconds,
        };
      }
      set.status = 409;
      return { error: e?.message ?? 'session metadata mismatch on resume' };
    }

    // Short-circuit when the upload already finished server-side. The device
    // is retrying because something AFTER the original ingest (sidecar /
    // rendered / live video) failed and re-enqueued the task — re-uploading
    // the same bytes is wasted work, and the client's downstream steps
    // (sidecar PUT, rendered POST) only need `maple_id` + `target_rel_path`
    // to proceed. Skip chunk processing entirely.
    if (alreadyComplete) {
      log.debug(
        { phid, mapleId: session.maple_id, targetRelPath: session.target_rel_path },
        'ingest short-circuit (already complete)',
      );
      set.status = 200;
      return {
        maple_id: session.maple_id,
        target_rel_path: session.target_rel_path,
      };
    }

    // Use the stored target_rel_path as the source of truth (not the freshly
    // computed value) — prevents a client from redirecting an in-progress
    // upload by sending different metadata on resume.
    const resolvedTargetRelPath = session.target_rel_path;

    // Write chunk to a per-session tmp file.
    const tmpFile = path.join(CHUNK_DIR, `${session._id.toHexString()}.part`);
    await fs.mkdir(CHUNK_DIR, { recursive: true });

    // The session was reset in place (metadata mismatch self-heal). Clear any
    // stale tmp bytes from the previous attempt so the next appendFile starts
    // at offset 0 cleanly. Only ENOENT is tolerable — anything else means we
    // could end up appending fresh bytes onto stale ones (start === 0 skips
    // the tmp-size check below) and silently corrupt the assembled upload.
    if (didReset) {
      try {
        await fs.unlink(tmpFile);
      } catch (e: any) {
        if (e?.code !== 'ENOENT') {
          set.status = 500;
          return { error: `could not clear stale tmp file: ${e?.message ?? 'unlink failed'}` };
        }
      }
    }

    // Enforce resume offset — reject if client is behind or ahead.
    if (session.received_bytes !== start) {
      set.status = 409;
      return { error: 'resume offset mismatch', expected_offset: session.received_bytes };
    }

    const buf = body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(body as ArrayBuffer);

    // Verify body length matches Content-Range claim.
    const expectedChunkLen = end - start + 1;
    if (buf.byteLength !== expectedChunkLen) {
      set.status = 400;
      return {
        error: `body length ${buf.byteLength} does not match Content-Range span ${expectedChunkLen}`,
      };
    }

    // Verify tmp file size is consistent with DB state before appending.
    if (start !== 0) {
      let tmpStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
      try {
        tmpStat = await fs.stat(tmpFile);
      } catch {
        // File missing but start != 0 — DB is out of sync with disk.
        await uploadSessions.resetForRestart(session._id);
        set.status = 409;
        return { error: 'tmp file missing — restart required', expected_offset: 0 };
      }
      if (tmpStat.size !== session.received_bytes) {
        set.status = 409;
        return {
          error: 'tmp file size mismatch — restart required',
          expected_offset: tmpStat.size,
        };
      }
    }

    await fs.appendFile(tmpFile, buf);
    await uploadSessions.recordChunk({ sessionId: session._id, bytesReceived: buf.byteLength });

    const isFinalChunk = end + 1 === rangeTotal;
    if (!isFinalChunk) {
      set.status = 202;
      return { next_offset: end + 1 };
    }

    // -----------------------------------------------------------------------
    // Final chunk — dedup check first, then move assembled file into place.
    // -----------------------------------------------------------------------

    if (!mapleId) {
      set.status = 400;
      return { error: 'X-Maple-Maple-Id required on final chunk' };
    }

    // 1. Dedup lookup BEFORE any filesystem operations.
    const a = await assetsCollection();
    const existing = await a.findOne({ maple_id: mapleId });
    const link: {
      device_id: string;
      phasset_local_id: string;
      phasset_cloud_id?: string;
      first_seen: Date;
    } = { device_id: deviceId, phasset_local_id: phid, first_seen: new Date() };
    if (phCloudId) link.phasset_cloud_id = phCloudId;

    if (existing) {
      // Same content already stored — just link this device to the existing row.
      const alreadyLinked = (existing.phasset_links ?? []).some(
        (l: any) => l.device_id === deviceId && l.phasset_local_id === phid,
      );
      if (!alreadyLinked) {
        await a.updateOne({ _id: existing._id }, { $push: { phasset_links: link } });
      }
      // Delete tmp file — the canonical copy at existing.abs_path is the
      // authoritative location; we don't need a second copy on disk.
      try {
        await fs.unlink(tmpFile);
      } catch {
        /* already gone */
      }
      await uploadSessions.complete({ sessionId: session._id, mapleId });
      await backupSessionsRepo.upsertProgress({
        libraryId,
        deviceId,
        uploadedDelta: 1,
        failedDelta: 0,
      });
      log.debug({ phid, mapleId, dedup: true }, 'ingest complete (dedup)');
      set.status = 200;
      return { maple_id: mapleId, target_rel_path: path.relative(folder.path, existing.abs_path) };
    }

    // 2. No existing row — move tmp into the final destination.
    const finalPath = path.join(folder.path, resolvedTargetRelPath);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });

    // Guard against a path collision: file on disk but no Mongo row references it.
    try {
      await fs.stat(finalPath);
      // File already exists — this is a server-state inconsistency.
      set.status = 500;
      return { error: `path collision; file exists at ${resolvedTargetRelPath}` };
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
      // ENOENT is expected — the path is free.
    }

    await atomicMove(tmpFile, finalPath);
    await uploadSessions.complete({ sessionId: session._id, mapleId });

    await a.insertOne({
      _id: new ObjectId(),
      folder_id: libraryId,
      filename,
      abs_path: finalPath,
      size: totalBytes,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      maple_id: mapleId,
      phasset_links: [link],
      deleted_from_photos: false,
    } as any);

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
