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
import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import { assetsCollection, foldersCollection } from "../db/client.ts";
import {
  uploadSessions,
  BusyElsewhereError,
} from "../backup/upload-session.ts";
import { formatBackupPath } from "../backup/path-formatter.ts";
import { BACKUP_CHUNK_DIR } from "../backup/config.ts";
import {
  atomicMove,
  filesIdentical,
  firstFreeSiblingPath,
} from "../backup/fs-util.ts";
import { resolveBackupLocation } from "../backup/ingest-geocode.ts";
import { backupSessionsRepo } from "../db/backup-sessions.repo.ts";
import { child as childLogger } from "../log.ts";
import fs from "node:fs/promises";
import path from "node:path";

const log = childLogger("backup-ingest");

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
    const folder = await (
      await foldersCollection()
    ).findOne({ _id: libraryId });
    if (!folder) {
      set.status = 404;
      return { error: "library not found" };
    }

    // Extract + validate required headers.
    const deviceId = headers["x-maple-device-id"];
    const phid = headers["x-maple-phasset-id"];
    // Stable across every device on the same iCloud Photos account. Optional
    // — non-iCloud library users won't have a cloud id, and the merge logic
    // falls back to phasset_local_id matching in that case.
    const phCloudId = headers["x-maple-phasset-cloud-id"];
    const captureRaw = headers["x-maple-capture-date"];
    const filename = headers["x-maple-filename"];
    const totalBytesRaw = headers["x-maple-total-bytes"];
    const latRaw = headers["x-maple-lat"];
    const lonRaw = headers["x-maple-lon"];
    const mapleId = headers["x-maple-maple-id"];
    const range = headers["content-range"];

    if (
      !deviceId ||
      !phid ||
      !captureRaw ||
      !filename ||
      !totalBytesRaw ||
      !range
    ) {
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
    if (end < start) {
      set.status = 400;
      return { error: "invalid Content-Range: end must be >= start" };
    }
    if (end >= rangeTotal) {
      set.status = 400;
      return { error: "invalid Content-Range: end must be < total" };
    }
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

    // Resolve GPS → location name. Warm-cache hit first, then a live Nominatim
    // lookup when configured (so a cold cache on a fresh bulk import still gets
    // a geocoded path). Any miss/failure is soft — path falls back to the
    // date-only layout.
    const lat = parseFloat(latRaw ?? "NaN");
    const lon = parseFloat(lonRaw ?? "NaN");
    const location = await resolveBackupLocation(lat, lon);

    // Compute the destination relative path.
    let targetRelPath: string;
    try {
      targetRelPath = formatBackupPath({ captureDate, location, filename });
    } catch (e: any) {
      set.status = 400;
      return { error: e?.message ?? "invalid filename" };
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
      return { error: e?.message ?? "session metadata mismatch on resume" };
    }

    // Short-circuit when the upload already finished server-side. The device
    // is retrying because something AFTER the original ingest (sidecar /
    // rendered / live video) failed and re-enqueued the task — re-uploading
    // the same bytes is wasted work, and the client's downstream steps
    // (sidecar PUT, rendered POST) only need `maple_id` + `target_rel_path`
    // to proceed. Skip chunk processing entirely.
    if (alreadyComplete) {
      log.debug(
        {
          phid,
          mapleId: session.maple_id,
          targetRelPath: session.target_rel_path,
        },
        "ingest short-circuit (already complete)",
      );
      set.status = 200;
      return {
        maple_id: session.maple_id,
        target_rel_path: session.target_rel_path,
      };
    }

    // Use the stored target_rel_path as the source of truth (not the freshly
    // computed value) — prevents a client from redirecting an in-progress
    // upload by sending different metadata on resume. May be reassigned below
    // if a genuinely different asset already occupies the computed path.
    let resolvedTargetRelPath = session.target_rel_path;

    // Write chunk to a per-session tmp file.
    const tmpFile = path.join(
      BACKUP_CHUNK_DIR,
      `${session._id.toHexString()}.part`,
    );
    await fs.mkdir(BACKUP_CHUNK_DIR, { recursive: true });

    // The session was reset in place (metadata mismatch self-heal). Clear any
    // stale tmp bytes from the previous attempt so the next appendFile starts
    // at offset 0 cleanly. Only ENOENT is tolerable — anything else means we
    // could end up appending fresh bytes onto stale ones (start === 0 skips
    // the tmp-size check below) and silently corrupt the assembled upload.
    if (didReset) {
      try {
        await fs.unlink(tmpFile);
      } catch (e: any) {
        if (e?.code !== "ENOENT") {
          set.status = 500;
          return {
            error: `could not clear stale tmp file: ${e?.message ?? "unlink failed"}`,
          };
        }
      }
    }

    // Enforce resume offset — reject if client is behind or ahead.
    if (session.received_bytes !== start) {
      set.status = 409;
      return {
        error: "resume offset mismatch",
        expected_offset: session.received_bytes,
      };
    }

    const buf =
      body instanceof Uint8Array
        ? Buffer.from(body)
        : Buffer.from(body as ArrayBuffer);

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
        return {
          error: "tmp file missing — restart required",
          expected_offset: 0,
        };
      }
      if (tmpStat.size !== session.received_bytes) {
        set.status = 409;
        return {
          error: "tmp file size mismatch — restart required",
          expected_offset: tmpStat.size,
        };
      }
    }

    await fs.appendFile(tmpFile, buf);
    await uploadSessions.recordChunk({
      sessionId: session._id,
      bytesReceived: buf.byteLength,
    });

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
      return { error: "X-Maple-Maple-Id required on final chunk" };
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
      // Same content already stored somewhere. Whether we can pure-dedup
      // (no second copy on disk) depends on which library that copy lives in.
      //
      // maple_id is a GLOBAL content hash — not scoped to a library. The
      // matched row may carry fileinfo only for some OTHER library (e.g. the
      // photo was discovered by a folder scan, or backed up to a different
      // library first). The downstream sidecar / rendered routes look the
      // asset up scoped to THIS library (`fileinfo.library_id == libraryId`),
      // so if we link-and-dedup against an other-library row without giving
      // THIS library a fileinfo entry, those steps 404 — which is the backup
      // failure this branch caused. The invariant: backing a photo up to
      // library Y must leave a usable fileinfo entry referencing Y.
      const liveInThisLibrary = (existing.fileinfo ?? []).find(
        (e: any) =>
          !e.deleted_at &&
          e.library_id?.toHexString?.() === libraryId.toHexString(),
      );

      const relFromFileInfo = (entry: any): string =>
        entry && entry.path !== undefined
          ? entry.path === ""
            ? entry.filename
            : `${entry.path}/${entry.filename}`
          : "";

      // Link this device to the existing row (idempotent on retry).
      const alreadyLinked = (existing.phasset_links ?? []).some(
        (l: any) => l.device_id === deviceId && l.phasset_local_id === phid,
      );

      if (liveInThisLibrary) {
        // Content already on disk in THIS library — true dedup. Drop the tmp
        // bytes; the canonical copy already lives at this library's fileinfo
        // entry.
        if (!alreadyLinked) {
          await a.updateOne(
            { _id: existing._id },
            { $push: { phasset_links: link } },
          );
        }
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
        log.debug(
          { phid, mapleId, dedup: true },
          "ingest complete (dedup, same library)",
        );
        set.status = 200;
        // Reconstruct this library's rel path so the device knows where the
        // canonical copy lives (used to route subsequent change-feed updates).
        return {
          maple_id: mapleId,
          target_rel_path: relFromFileInfo(liveInThisLibrary),
        };
      }

      // Content exists, but NOT in this library — materialize a copy here so
      // this library gets its own fileinfo entry (and the folder-scoped
      // sidecar / rendered lookups succeed). We still avoid re-deriving the
      // id or re-running enrichment: this is the same content-addressed row,
      // we only add a location.
      const finalPath = path.join(folder.path, resolvedTargetRelPath);
      await fs.mkdir(path.dirname(finalPath), { recursive: true });

      // If the file already sits at the target path (e.g. a prior attempt
      // moved it but Mongo didn't record this library's fileinfo entry), reuse
      // it rather than clobbering — but only when it matches the freshly
      // assembled upload's size. A stale/partial file of a different size must
      // not be silently adopted and referenced by a new fileinfo entry, so we
      // overwrite it with the just-assembled tmp instead.
      let needMove = true;
      try {
        const destStat = await fs.stat(finalPath);
        const tmpStat = await fs.stat(tmpFile);
        needMove = destStat.size !== tmpStat.size;
      } catch (e: any) {
        if (e?.code !== "ENOENT") throw e;
      }
      if (needMove) {
        await atomicMove(tmpFile, finalPath);
      } else {
        try {
          await fs.unlink(tmpFile);
        } catch {
          /* already gone */
        }
      }

      const relDirRaw = path.dirname(resolvedTargetRelPath);
      const relDir =
        relDirRaw === "." || relDirRaw === ""
          ? ""
          : relDirRaw.split(path.sep).join("/");
      const newFileInfo = {
        path: relDir,
        filename,
        library_id: libraryId,
        deleted_at: null,
      };

      const update: Record<string, any> = { $push: { fileinfo: newFileInfo } };
      if (!alreadyLinked) {
        update.$push = { fileinfo: newFileInfo, phasset_links: link };
      }
      await a.updateOne({ _id: existing._id }, update);

      await uploadSessions.complete({ sessionId: session._id, mapleId });
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
        "ingest complete (dedup, materialized in target library)",
      );
      set.status = 200;
      return { maple_id: mapleId, target_rel_path: resolvedTargetRelPath };
    }

    // 2. No existing row — move tmp into the final destination.
    let finalPath = path.join(folder.path, resolvedTargetRelPath);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });

    // A file may already sit at the target path with no Mongo row referencing
    // it. Two situations produce that, and they need opposite handling:
    //
    //   (a) A half-finished prior attempt for THIS asset moved its bytes into
    //       place but the process died before the asset row was inserted (or
    //       the session marked complete). The on-disk file is byte-for-byte
    //       what we just re-assembled — adopt it and create the missing row.
    //       This is the spurious 500 the device hits on retry of an upload
    //       that already (mostly) succeeded.
    //
    //   (b) A genuinely different asset already owns this path — two photos
    //       that share a capture date + filename and resolve to the same (or,
    //       on a cold geocode cache, no) location. Clobbering would lose a
    //       photo; failing would strand this one. Move to the next free
    //       sibling path and report the adjusted path back to the device.
    let needMove = true;
    try {
      await fs.stat(finalPath);
      if (await filesIdentical(finalPath, tmpFile)) {
        // (a) Recovery — the canonical bytes are already in place.
        needMove = false;
        try {
          await fs.unlink(tmpFile);
        } catch {
          /* already gone */
        }
        log.debug(
          { phid, mapleId, targetRelPath: resolvedTargetRelPath },
          "ingest recovery (matching bytes already on disk, no row) — adopting",
        );
      } else {
        // (b) Real collision — disambiguate to a free sibling path.
        const free = await firstFreeSiblingPath(
          folder.path,
          resolvedTargetRelPath,
        );
        log.warn(
          {
            phid,
            mapleId,
            collidedRelPath: resolvedTargetRelPath,
            resolvedRelPath: free.relPath,
          },
          "ingest path collision (different bytes) — disambiguated",
        );
        resolvedTargetRelPath = free.relPath;
        finalPath = free.absPath;
        await fs.mkdir(path.dirname(finalPath), { recursive: true });
      }
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
      // ENOENT is expected — the path is free.
    }

    if (needMove) {
      await atomicMove(tmpFile, finalPath);
    }
    await uploadSessions.complete({ sessionId: session._id, mapleId });

    // fileinfo[0] mirrors the resolved target path split into
    // (directory relative to library, filename, library_id).
    // FileInfo.path is documented as POSIX-separated; normalize sep
    // here so a host with `\` as path.sep doesn't store backslashes.
    const relDirRaw = path.dirname(resolvedTargetRelPath);
    const relDir =
      relDirRaw === "." || relDirRaw === ""
        ? ""
        : relDirRaw.split(path.sep).join("/");
    await a.insertOne({
      _id: new ObjectId(),
      fileinfo: [
        {
          path: relDir,
          filename,
          library_id: libraryId,
          deleted_at: null,
        },
      ],
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

    // Update per-device backup progress summary.
    await backupSessionsRepo.upsertProgress({
      libraryId,
      deviceId,
      uploadedDelta: 1,
      failedDelta: 0,
    });

    log.debug(
      { phid, targetRelPath: resolvedTargetRelPath, mapleId },
      "ingest complete",
    );
    set.status = 200;
    return { maple_id: mapleId, target_rel_path: resolvedTargetRelPath };
  },
  {
    params: t.Object({ libraryId: t.String() }),
    body: t.Any(),
  },
);
