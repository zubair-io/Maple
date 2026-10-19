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
 *   X-Maple-Sidecar-Base    — optional — compare-and-swap re-send (#4719): the
 *                             SHA-256 (hex) of the sidecar this device last
 *                             delivered, or `none` for its first. Present →
 *                             the write never skips: a matching base
 *                             overwrites; a stale one still lands the edit and
 *                             keeps the displaced XMP in `sidecar_divergences`.
 *                             Absent → the legacy skip-if-exists rule.
 *
 * Body: raw XMP string (utf-8). Max size: 256 KB.
 *
 * Responses:
 *   200 — { target_rel_path: "...xmp" }            — written
 *   200 — { target_rel_path: "...xmp", skipped: true } — already on disk, not overwritten (no base header)
 *   200 — { target_rel_path: "...xmp", unchanged: true } — the server already holds this XMP
 *   200 — { target_rel_path: "...xmp", diverged: true } — written over a version the base didn't name
 *   400 — missing/invalid headers (including a malformed base), unsafe path
 *   404 — library not found, or no prior upload (neither maple_id nor device+phasset matched)
 *   413 — body exceeds 256 KB
 */
import { backupId, backupLibrary, backupLibraryId } from './backup-id.ts';
import { atomicMove } from '../backup/fs-util.ts';
import { Elysia, t } from 'elysia';
import { findLiveAssetIdByMapleId, findLiveAssetIdByPhassetLink } from '../db/repos/assets.repo.ts';
import { child as childLogger } from '../log.ts';
// Mirror-aware drop-in: the sidecar publish (atomicMove → rename/copyFile)
// replicates to the library's backup root(s).
import fs from '../fs/mirrored.ts';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { publishSidecarCas } from '../backup/sidecar-cas.ts';
import { recordSidecarDivergence } from '../db/repos/sidecar-divergences.repo.ts';

const log = childLogger('backup-sidecar');
const MAX_SIDECAR_BYTES = 256 * 1024; // 256 KB
const SHA256_HEX = /^[0-9a-f]{64}$/;

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
    const libraryId = backupLibraryId(params.libraryId);
    if (libraryId instanceof Response) return libraryId;

    // Extract + validate required headers.
    const deviceId = headers['x-maple-device-id'];
    const phid = headers['x-maple-phasset-id'];
    const targetRelPath = headers['x-maple-target-rel-path'];
    // Optional content-hash dedup key. Primary lookup when present (#698).
    const mapleId = backupId(headers['x-maple-id'], 'x-maple-id');
    if (mapleId instanceof Response) return mapleId;

    if (!deviceId || !phid || !targetRelPath) {
      set.status = 400;
      return { error: 'missing required headers' };
    }

    const baseHeader = headers['x-maple-sidecar-base'];
    if (baseHeader !== undefined && baseHeader !== 'none' && !SHA256_HEX.test(baseHeader)) {
      set.status = 400;
      return { error: 'X-Maple-Sidecar-Base must be a SHA-256 hex digest or "none"' };
    }

    // Path-traversal guard.
    if (!isSafeRelPath(targetRelPath)) {
      set.status = 400;
      return { error: 'unsafe X-Maple-Target-Rel-Path' };
    }

    // Check library exists.
    const folder = await backupLibrary(libraryId);
    if (folder instanceof Response) return folder;

    // Verify prior asset upload — sidecar without prior upload is an error.
    // Scope by a LIVE location in this library, not the retired top-level
    // `folder_id` (dropped in drop-abs-path-2026-05-21). The live guard
    // ensures we don't accept a sidecar write against a soft-deleted
    // (trashed) location. backup-ingest writes the on-disk pointer as a
    // location row; querying the legacy `folder_id` matched nothing for a
    // freshly-ingested asset and 404'd the sidecar even though the original
    // bytes landed. Mirrors the rendered route's library scoping.
    //
    // PRIMARY lookup: by `maple_id` (content-hash dedup key) when the client
    // sent `X-Maple-Id`. A content-duplicate photo (already uploaded by another
    // device, or re-imported under a new PHAsset local id) won't carry THIS
    // device's phasset link, so the device+phasset query below misses and
    // 404s even though the asset + bytes exist (#698). The maple_id is stable
    // across devices, so it resolves the dedup case.
    //
    // FALLBACK: by (device_id, phasset_local_id) — for an older client that
    // doesn't send `X-Maple-Id`, or when the maple_id lookup missed. Both
    // columns belong to one link row, so an asset linked to (deviceA, id1) and
    // (deviceB, id2) can no longer answer a lookup for (deviceA, id2) the way
    // the two dotted paths this replaces allowed.
    const asset =
      (mapleId ? await findLiveAssetIdByMapleId(mapleId, libraryId) : null) ??
      (await findLiveAssetIdByPhassetLink(deviceId, phid, libraryId));
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

    if (baseHeader !== undefined) {
      await fs.mkdir(path.dirname(finalPath), { recursive: true });
      const outcome = await publishSidecarCas(
        finalPath,
        buf.toString('utf8'),
        baseHeader === 'none' ? null : baseHeader,
        (displaced) =>
          recordSidecarDivergence({
            assetId: asset,
            libraryId,
            sidecarRelPath,
            deviceId,
            baseSha256: baseHeader === 'none' ? null : baseHeader,
            displacedSha256: displaced.sha256,
            displacedXmp: displaced.xmp,
            incomingSha256: displaced.incomingSha256,
          }),
        folder.path,
      );
      if (outcome.kind === 'error') {
        log.error(
          { phid, sidecarRelPath, error: outcome.error },
          'sidecar compare-and-swap failed',
        );
        set.status = 500;
        return { error: 'sidecar write failed' };
      }
      log.debug({ phid, sidecarRelPath, outcome: outcome.kind }, 'sidecar compare-and-swap');
      set.status = 200;
      return outcome.kind === 'written'
        ? { target_rel_path: sidecarRelPath }
        : { target_rel_path: sidecarRelPath, [outcome.kind]: true };
    }

    // SKIP-IF-EXISTS: a dedup re-upload from a second device must not clobber
    // the first device's (possibly already-edited) sidecar. If `<path>.xmp`
    // already exists on disk, treat the write as a no-op (#698). Clients that
    // name a base take the compare-and-swap path above instead.
    try {
      await fs.access(finalPath);
      log.debug({ phid, sidecarRelPath }, 'sidecar already exists — skipping write');
      set.status = 200;
      return { target_rel_path: sidecarRelPath, skipped: true };
    } catch {
      // Not present (ENOENT) — proceed to write.
    }

    await fs.mkdir(path.dirname(finalPath), { recursive: true });

    // Atomic write: sibling temp file next to final destination, then rename.
    // The `.tmp.` marker prevents mirroring churn (see fs/mirrored.ts).
    const tmpFile = `${finalPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
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
