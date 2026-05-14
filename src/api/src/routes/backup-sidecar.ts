/**
 * POST /api/libraries/:libraryId/backup/sidecar
 *
 * Write an XMP sidecar file next to a previously-uploaded asset.
 *
 * Headers:
 *   X-Maple-Device-Id       — required
 *   X-Maple-Phasset-Id      — required
 *   X-Maple-Target-Rel-Path — required — the relative path the original was
 *                             written to (e.g. "2024/Tokyo/03-15/IMG.HEIC").
 *                             Server writes "<that-path>.xmp".
 *
 * Body: raw XMP string (utf-8). Max size: 256 KB.
 *
 * Responses:
 *   200 — { target_rel_path: "...xmp" }
 *   400 — missing/invalid headers, body too large, unsafe path
 *   404 — library not found, or no prior upload for this device+phasset
 *   413 — body exceeds 256 KB
 */
import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import { assetsCollection, foldersCollection } from "../db/client.ts";
import { child as childLogger } from "../log.ts";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const log = childLogger("backup-sidecar");
const MAX_SIDECAR_BYTES = 256 * 1024; // 256 KB

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
 * no backslash, does not start with "." at the first segment.
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

export const backupSidecarRoutes = new Elysia().post(
  "/api/libraries/:libraryId/backup/sidecar",
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
    const targetRelPath = headers["x-maple-target-rel-path"];

    if (!deviceId || !phid || !targetRelPath) {
      set.status = 400;
      return { error: "missing required headers" };
    }

    // Path-traversal guard.
    if (!isSafeRelPath(targetRelPath)) {
      set.status = 400;
      return { error: "unsafe X-Maple-Target-Rel-Path" };
    }

    // Check library exists.
    const folder = await (await foldersCollection()).findOne({ _id: libraryId });
    if (!folder) {
      set.status = 404;
      return { error: "library not found" };
    }

    // Verify prior asset upload — sidecar without prior upload is an error.
    const a = await assetsCollection();
    const asset = await a.findOne({
      folder_id: libraryId,
      "phasset_links.device_id": deviceId,
      "phasset_links.phasset_local_id": phid,
    });
    if (!asset) {
      set.status = 404;
      return { error: "no prior upload for this device and phasset" };
    }

    // Validate body (raw bytes or Buffer).
    const buf =
      body instanceof Uint8Array
        ? Buffer.from(body)
        : Buffer.from(body as ArrayBuffer);

    if (buf.byteLength === 0) {
      set.status = 400;
      return { error: "body must not be empty" };
    }

    if (buf.byteLength > MAX_SIDECAR_BYTES) {
      set.status = 413;
      return { error: "sidecar body exceeds 256 KB limit" };
    }

    // Compute final sidecar path: <library>/<targetRelPath>.xmp
    const sidecarRelPath = `${targetRelPath}.xmp`;
    const finalPath = path.join(folder.path, sidecarRelPath);

    // Guard: ensure the computed absolute path is under the library root.
    if (!finalPath.startsWith(folder.path + path.sep) && finalPath !== folder.path) {
      set.status = 400;
      return { error: "path escape detected" };
    }

    await fs.mkdir(path.dirname(finalPath), { recursive: true });

    // Atomic write: temp file alongside the final destination, then rename.
    const tmpDir = path.dirname(finalPath);
    const tmpFile = path.join(
      os.tmpdir(),
      `maple-sidecar-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    await fs.writeFile(tmpFile, buf);
    await atomicMove(tmpFile, finalPath);

    log.debug({ phid, sidecarRelPath }, "sidecar written");
    set.status = 200;
    return { target_rel_path: sidecarRelPath };
  },
  {
    params: t.Object({ libraryId: t.String() }),
    body: t.Any(),
  },
);
