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
 *
 * Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §20.
 */
import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import {
  assetsCollection,
  foldersCollection,
  geocodeCacheCollection,
} from "../db/client.ts";
import { uploadSessions } from "../backup/upload-session.ts";
import { formatBackupPath } from "../backup/path-formatter.ts";
import { backupSessionsRepo } from "../db/backup-sessions.repo.ts";
import { quantizedKey } from "../enrichment/coordinate-cache.ts";
import { child as childLogger } from "../log.ts";
import fs from "node:fs/promises";
import path from "node:path";

const log = childLogger("backup-ingest");
const CHUNK_DIR = process.env.MAPLE_BACKUP_TMP ?? "/tmp/maple-backup-chunks";

/** Resolve a location name from the geocode cache. Returns null on miss. */
async function resolveLocation(lat: number, lon: number): Promise<string | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const coll = await geocodeCacheCollection();
  const row = await coll.findOne({ _id: quantizedKey(lat, lon) });
  if (!row) return null;
  return row.place.pois[0]?.name ?? row.place.rollups?.locality ?? null;
}

export const backupIngestRoutes = new Elysia().post(
  "/api/libraries/:libraryId/backup/ingest",
  async ({ params, headers, body, set }) => {
    // Validate library id.
    let libraryId: ObjectId;
    try {
      libraryId = new ObjectId(params.libraryId);
    } catch {
      set.status = 400;
      return { error: "invalid library id" };
    }

    // Check library exists.
    const folder = await (await foldersCollection()).findOne({ _id: libraryId });
    if (!folder) {
      set.status = 404;
      return { error: "library not found" };
    }

    // Extract + validate required headers.
    const deviceId = headers["x-maple-device-id"];
    const phid = headers["x-maple-phasset-id"];
    const captureRaw = headers["x-maple-capture-date"];
    const filename = headers["x-maple-filename"];
    const totalBytesRaw = headers["x-maple-total-bytes"];
    const latRaw = headers["x-maple-lat"];
    const lonRaw = headers["x-maple-lon"];
    const mapleId = headers["x-maple-maple-id"];
    const range = headers["content-range"];

    if (!deviceId || !phid || !captureRaw || !filename || !totalBytesRaw || !range) {
      set.status = 400;
      return { error: "missing required headers" };
    }

    const totalBytes = parseInt(totalBytesRaw, 10);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
      set.status = 400;
      return { error: "invalid X-Maple-Total-Bytes" };
    }

    // Parse Content-Range: bytes <start>-<end>/<total>
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!m) {
      set.status = 400;
      return { error: "invalid Content-Range" };
    }
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    const rangeTotal = parseInt(m[3], 10);
    if (rangeTotal !== totalBytes) {
      set.status = 400;
      return { error: "Content-Range total mismatch with X-Maple-Total-Bytes" };
    }

    // Parse and validate capture date.
    const captureDate = new Date(captureRaw);
    if (isNaN(captureDate.getTime())) {
      set.status = 400;
      return { error: "invalid X-Maple-Capture-Date" };
    }

    // Resolve GPS → location name (cache miss is a soft failure — path falls back to date-only layout).
    const lat = parseFloat(latRaw ?? "NaN");
    const lon = parseFloat(lonRaw ?? "NaN");
    const location = await resolveLocation(lat, lon);

    // Compute the destination relative path.
    const targetRelPath = formatBackupPath({ captureDate, location, filename });

    // Open or resume the upload session.
    const session = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: phid,
      totalBytes,
      chunkSize: end - start + 1,
      targetRelPath,
    });

    // Enforce resume offset — reject if client is behind or ahead.
    if (session.received_bytes !== start) {
      set.status = 409;
      return { error: "resume offset mismatch", expected_offset: session.received_bytes };
    }

    // Write chunk to a per-session tmp file.
    const tmpFile = path.join(CHUNK_DIR, `${session._id.toHexString()}.part`);
    await fs.mkdir(CHUNK_DIR, { recursive: true });

    const buf =
      body instanceof Uint8Array
        ? Buffer.from(body)
        : Buffer.from(body as ArrayBuffer);

    await fs.appendFile(tmpFile, buf);
    await uploadSessions.recordChunk({ sessionId: session._id, bytesReceived: buf.byteLength });

    const isFinalChunk = end + 1 === rangeTotal;
    if (!isFinalChunk) {
      set.status = 202;
      return { next_offset: end + 1 };
    }

    // -----------------------------------------------------------------------
    // Final chunk — move assembled file into place, upsert AssetDoc.
    // -----------------------------------------------------------------------

    if (!mapleId) {
      set.status = 400;
      return { error: "X-Maple-Maple-Id required on final chunk" };
    }

    const finalPath = path.join(folder.path, targetRelPath);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    // fs.rename is atomic on the same FS; removes the source (tmp file cleanup included).
    await fs.rename(tmpFile, finalPath);
    await uploadSessions.complete({ sessionId: session._id, mapleId });

    // Upsert AssetDoc — dedup via maple_id.
    const a = await assetsCollection();
    const existing = await a.findOne({ maple_id: mapleId });
    const link = { device_id: deviceId, phasset_local_id: phid, first_seen: new Date() };

    if (existing) {
      // Same content from a second device — add a phasset_link only if not already present.
      await a.updateOne(
        { _id: existing._id, "phasset_links.phasset_local_id": { $ne: phid } },
        { $push: { phasset_links: link } },
      );
    } else {
      await a.insertOne({
        _id: new ObjectId(),
        folder_id: libraryId,
        filename,
        abs_path: finalPath,
        size: totalBytes,
        mtime: Date.now(),
        rating: 0,
        flag: 0,
        color_label: "",
        indexed_at: new Date().toISOString(),
        maple_id: mapleId,
        phasset_links: [link],
        deleted_from_photos: false,
      } as any);
    }

    // Update per-device backup progress summary.
    await backupSessionsRepo.upsertProgress({
      libraryId,
      deviceId,
      uploadedDelta: 1,
      failedDelta: 0,
    });

    log.debug({ phid, targetRelPath, mapleId }, "ingest complete");
    set.status = 200;
    return { maple_id: mapleId, target_rel_path: targetRelPath };
  },
  {
    params: t.Object({ libraryId: t.String() }),
    body: t.Any(),
  },
);
