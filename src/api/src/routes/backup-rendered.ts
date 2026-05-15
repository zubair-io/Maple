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
 *   X-Maple-Maple-Id        — required on the final chunk
 *
 * Responses:
 *   202 — chunk accepted. { next_offset }
 *   200 — final chunk. { target_rel_path }
 *   400 — missing/invalid headers, unsafe path
 *   404 — library not found
 *   409 — resume offset mismatch
 *   423 — another device is actively uploading the same iCloud photo.
 *         Body: { retry_after_seconds, defer_positions }. Same-key metadata
 *         mismatches self-heal silently (session reset in place).
 */
import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import {
  assetsCollection,
  foldersCollection,
} from "../db/client.ts";
import { uploadSessions, BusyElsewhereError } from "../backup/upload-session.ts";
import { child as childLogger } from "../log.ts";
import fs from "node:fs/promises";
import path from "node:path";

const log = childLogger("backup-rendered");
const CHUNK_DIR = process.env.MAPLE_BACKUP_TMP ?? "/tmp/maple-backup-chunks";

/** Move src to dst atomically. Falls back to copy+unlink on EXDEV (cross-device). */
async function atomicMove(src: string, dst: string): Promise<void> {
  try {
    await fs.rename(src, dst);
  } catch (e: any) {
    if (e?.code === "EXDEV") {
      await fs.copyFile(src, dst);
      await fs.unlink(src);
    } else {
      throw e;
    }
  }
}

/**
 * Validate that a relative path is safe: no ".." segments, no leading slash,
 * no backslash, no empty segments.
 */
function isSafeRelPath(relPath: string): boolean {
  if (!relPath || relPath.length === 0 || relPath.length > 2048) return false;
  if (relPath.startsWith("/") || relPath.startsWith("\\")) return false;
  const parts = relPath.split(/[/\\]/);
  for (const part of parts) {
    if (part === ".." || part === ".") return false;
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
  const base = originalRelPath.slice(0, originalRelPath.length - path.extname(originalRelPath).length);
  if (suffixOverride) {
    const normalSuffix = suffixOverride.startsWith(".") ? suffixOverride.slice(1) : suffixOverride;
    return `${base}.${normalSuffix}`;
  }
  const extToUse = ext ?? path.extname(originalRelPath);
  const normalExt = extToUse.startsWith(".") ? extToUse : `.${extToUse}`;
  return `${base}.rendered${normalExt}`;
}

export const backupRenderedRoutes = new Elysia().post(
  "/api/libraries/:libraryId/backup/rendered",
  async ({ params, headers, body, set }) => {
    // Validate library id.
    let libraryId: ObjectId;
    try {
      libraryId = new ObjectId(params.libraryId);
    } catch {
      set.status = 400;
      return { error: "invalid library id" };
    }

    // Extract + validate required headers.
    const deviceId = headers["x-maple-device-id"];
    const phid = headers["x-maple-phasset-id"];
    const originalRelPath = headers["x-maple-target-rel-path"];
    const totalBytesRaw = headers["x-maple-total-bytes"];
    const range = headers["content-range"];
    const mapleId = headers["x-maple-maple-id"];
    const filenameExt = headers["x-maple-filename-ext"];
    // Optional suffix-override: when present, the assembled file is named
    // `<base>.<suffixOverride>` instead of `<base>.rendered.<ext>`.
    // Used by the Live Photo .mov path to avoid the `.rendered.` infix.
    const suffixOverride = headers["x-maple-suffix-override"];

    if (!deviceId || !phid || !originalRelPath || !totalBytesRaw || !range) {
      set.status = 400;
      return { error: "missing required headers" };
    }

    // Path-traversal guard.
    if (!isSafeRelPath(originalRelPath)) {
      set.status = 400;
      return { error: "unsafe X-Maple-Target-Rel-Path" };
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

    // Check library exists.
    const folder = await (await foldersCollection()).findOne({ _id: libraryId });
    if (!folder) {
      set.status = 404;
      return { error: "library not found" };
    }

    // Compute target rel-path for the rendered companion.
    const targetRelPath = renderedRelPath(originalRelPath, filenameExt, suffixOverride);

    // Use synthetic phid so rendered sessions don't collide with original sessions.
    const syntheticPhid = `${phid}::rendered`;

    // Open or resume the upload session.
    let session;
    let didReset = false;
    try {
      const r = await uploadSessions.openOrResume({
        libraryId,
        deviceId,
        phassetLocalId: syntheticPhid,
        totalBytes,
        chunkSize: end - start + 1,
        targetRelPath,
      });
      session = r.session;
      didReset = r.reset;
    } catch (e: any) {
      if (e instanceof BusyElsewhereError) {
        set.status = 423;
        return {
          error: e.message,
          retry_after_seconds: e.retryAfterSeconds,
          defer_positions: 10,
        };
      }
      set.status = 409;
      return { error: e?.message ?? "session metadata mismatch on resume" };
    }

    const resolvedTargetRelPath = session.target_rel_path;

    // Append chunk to the per-session tmp file.
    const tmpFile = path.join(CHUNK_DIR, `${session._id.toHexString()}.part`);
    await fs.mkdir(CHUNK_DIR, { recursive: true });

    // Self-heal reset cleared received_bytes — also clear any stale tmp bytes
    // so the next append starts from 0.
    if (didReset) {
      try { await fs.unlink(tmpFile); } catch { /* missing is fine */ }
    }

    // Enforce resume offset.
    if (session.received_bytes !== start) {
      set.status = 409;
      return { error: "resume offset mismatch", expected_offset: session.received_bytes };
    }

    const buf =
      body instanceof Uint8Array
        ? Buffer.from(body)
        : Buffer.from(body as ArrayBuffer);

    // Verify body length matches Content-Range claim.
    const expectedChunkLen = end - start + 1;
    if (buf.byteLength !== expectedChunkLen) {
      set.status = 400;
      return { error: `body length ${buf.byteLength} does not match Content-Range span ${expectedChunkLen}` };
    }

    // Verify tmp file size is consistent with DB state before appending.
    if (start !== 0) {
      let tmpStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
      try {
        tmpStat = await fs.stat(tmpFile);
      } catch {
        await uploadSessions.resetForRestart(session._id);
        set.status = 409;
        return { error: "tmp file missing — restart required", expected_offset: 0 };
      }
      if (tmpStat.size !== session.received_bytes) {
        set.status = 409;
        return { error: "tmp file size mismatch — restart required", expected_offset: tmpStat.size };
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
    // Final chunk — move assembled file into place + update AssetDoc.
    // -----------------------------------------------------------------------

    if (!mapleId) {
      set.status = 400;
      return { error: "X-Maple-Maple-Id required on final chunk" };
    }

    const finalPath = path.join(folder.path, resolvedTargetRelPath);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await atomicMove(tmpFile, finalPath);
    await uploadSessions.complete({ sessionId: session._id, mapleId });

    // Persist apple_rendered_path on the matching AssetDoc.
    const a = await assetsCollection();
    await a.updateOne(
      { folder_id: libraryId, maple_id: mapleId },
      { $set: { apple_rendered_path: resolvedTargetRelPath } },
    );

    log.debug({ phid, targetRelPath: resolvedTargetRelPath, mapleId }, "rendered ingest complete");
    set.status = 200;
    return { target_rel_path: resolvedTargetRelPath };
  },
  {
    params: t.Object({ libraryId: t.String() }),
    body: t.Any(),
  },
);
