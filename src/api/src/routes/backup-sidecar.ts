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
 *   X-Maple-Id              — optional — the content-hash dedup key
 *                             (`maple_id`). When present, the asset is looked
 *                             up by it first; this covers content-duplicate
 *                             photos whose `phasset_link` for this device was
 *                             never attached (dedup / re-import), which the
 *                             device+phasset lookup misses (see #698).
 *
 * Body: raw XMP string (utf-8). Max size: 256 KB.
 *
 * Responses:
 *   200 — { target_rel_path: "...xmp" }            — written
 *   200 — { target_rel_path: "...xmp", skipped: true } — already on disk, not overwritten
 *   400 — missing/invalid headers, body too large, unsafe path
 *   404 — library not found, or no prior upload (neither maple_id nor device+phasset matched)
 *   413 — body exceeds 256 KB
 */
import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { assetsCollection, foldersCollection } from '../db/client.ts';
import { child as childLogger } from '../log.ts';
// Mirror-aware drop-in: the sidecar publish (atomicMove → rename/copyFile)
// replicates to the library's backup root(s).
import fs from '../fs/mirrored.ts';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const log = childLogger('backup-sidecar');
const MAX_SIDECAR_BYTES = 256 * 1024; // 256 KB

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

/**
 * Validate that a relative path is safe: no ".." segments, no leading slash,
 * no backslash, does not start with "." at the first segment.
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

export const backupSidecarRoutes = new Elysia().post(
  '/api/libraries/:libraryId/backup/sidecar',
  async ({ params, headers, body, set }) => {
    // Validate library id.
    let libraryId: ObjectId;
    try {
      libraryId = new ObjectId(params.libraryId);
    } catch {
      set.status = 400;
      return { error: 'invalid library id' };
    }

    // Extract + validate required headers.
    const deviceId = headers['x-maple-device-id'];
    const phid = headers['x-maple-phasset-id'];
    const targetRelPath = headers['x-maple-target-rel-path'];
    // Optional content-hash dedup key. Primary lookup when present (#698).
    const mapleId = headers['x-maple-id'];

    if (!deviceId || !phid || !targetRelPath) {
      set.status = 400;
      return { error: 'missing required headers' };
    }

    // Path-traversal guard.
    if (!isSafeRelPath(targetRelPath)) {
      set.status = 400;
      return { error: 'unsafe X-Maple-Target-Rel-Path' };
    }

    // Check library exists.
    const folder = await (await foldersCollection()).findOne({ _id: libraryId });
    if (!folder) {
      set.status = 404;
      return { error: 'library not found' };
    }

    // Verify prior asset upload — sidecar without prior upload is an error.
    // Scope by a LIVE `fileinfo` entry for this library, not the retired
    // top-level `folder_id` (dropped in drop-abs-path-2026-05-21). The
    // `deleted_at: null` element guard ensures we don't accept a sidecar
    // write against a soft-deleted (trashed) location. backup-ingest writes
    // the on-disk pointer onto `fileinfo[].library_id`; querying the legacy
    // `folder_id` matched nothing for a freshly-ingested asset and 404'd the
    // sidecar even though the original bytes landed. Mirrors the rendered
    // route's `fileinfo.library_id` scoping.
    //
    // PRIMARY lookup: by `maple_id` (content-hash dedup key) when the client
    // sent `X-Maple-Id`. A content-duplicate photo (already uploaded by another
    // device, or re-imported under a new PHAsset local id) won't carry THIS
    // device's `phasset_link`, so the device+phasset query below misses and
    // 404s even though the asset + bytes exist (#698). The maple_id is stable
    // across devices, so it resolves the dedup case.
    const liveFileinfo = { $elemMatch: { library_id: libraryId, deleted_at: null } };
    const a = await assetsCollection();
    let asset = null;
    if (mapleId) {
      asset = await a.findOne({
        maple_id: mapleId,
        fileinfo: liveFileinfo,
      });
    }
    // FALLBACK: by (device_id, phasset_local_id). Used when the client is an
    // older build that doesn't send `X-Maple-Id`, or when the maple_id lookup
    // missed. Preserves backwards compatibility.
    if (!asset) {
      asset = await a.findOne({
        fileinfo: liveFileinfo,
        'phasset_links.device_id': deviceId,
        'phasset_links.phasset_local_id': phid,
      });
    }
    if (!asset) {
      set.status = 404;
      return { error: 'no prior upload for this device and phasset' };
    }

    // Validate body (raw bytes or Buffer).
    const buf = body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(body as ArrayBuffer);

    if (buf.byteLength === 0) {
      set.status = 400;
      return { error: 'body must not be empty' };
    }

    if (buf.byteLength > MAX_SIDECAR_BYTES) {
      set.status = 413;
      return { error: 'sidecar body exceeds 256 KB limit' };
    }

    // Compute final sidecar path: <library>/<targetRelPath>.xmp
    const sidecarRelPath = `${targetRelPath}.xmp`;
    const finalPath = path.join(folder.path, sidecarRelPath);

    // Guard: ensure the computed absolute path is under the library root.
    if (!finalPath.startsWith(folder.path + path.sep) && finalPath !== folder.path) {
      set.status = 400;
      return { error: 'path escape detected' };
    }

    // SKIP-IF-EXISTS: a dedup re-upload from a second device must not clobber
    // the first device's (possibly already-edited) sidecar. If `<path>.xmp`
    // already exists on disk, treat the write as a no-op (#698). An explicit
    // edit-sync overwrite/force path is out of scope here.
    try {
      await fs.access(finalPath);
      log.debug({ phid, sidecarRelPath }, 'sidecar already exists — skipping write');
      set.status = 200;
      return { target_rel_path: sidecarRelPath, skipped: true };
    } catch {
      // Not present (ENOENT) — proceed to write.
    }

    await fs.mkdir(path.dirname(finalPath), { recursive: true });

    // Atomic write: temp file alongside the final destination, then rename.
    const tmpDir = path.dirname(finalPath);
    const tmpFile = path.join(
      os.tmpdir(),
      `maple-sidecar-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`,
    );
    await fs.writeFile(tmpFile, buf);
    await atomicMove(tmpFile, finalPath);

    log.debug({ phid, sidecarRelPath }, 'sidecar written');
    set.status = 200;
    return { target_rel_path: sidecarRelPath };
  },
  {
    params: t.Object({ libraryId: t.String() }),
    body: t.Any(),
    // Force raw-byte parsing regardless of incoming Content-Type. iOS clients
    // post the XMP with `Content-Type: application/xml`, whose char-at-12 is
    // 'x' — colliding with `application/x-www-form-urlencoded` in Elysia's
    // fast switch (compose.mjs:438-444), which would hand the handler a
    // URLSearchParams-parsed object instead of an ArrayBuffer.
    parse: 'arrayBuffer',
  },
);
