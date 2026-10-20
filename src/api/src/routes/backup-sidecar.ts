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
 *                             Server writes the canonical sidecar
 *                             (`xmpSidecarPath`): "IMG.xmp", or "IMG.MOV.xmp"
 *                             for a video (#5021).
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
 *                             The target must be a live location of the
 *                             resolved asset. Absent → the legacy rule: written
 *                             only when no sidecar exists (create-only, on the
 *                             same write barrier).
 *
 * Body: raw XMP string (utf-8). Max size: 256 KB.
 *
 * Responses:
 *   200 — { target_rel_path: "...xmp" }            — written
 *   200 — { target_rel_path: "...xmp", skipped: true } — already on disk, not overwritten (no base header)
 *   200 — { target_rel_path: "...xmp", unchanged: true } — the server already holds this XMP
 *   200 — { target_rel_path: "...xmp", diverged: true } — written over a version the base didn't name
 *   200 — { target_rel_path: "...xmp", shared: true } — a same-stem sibling shares the sidecar and
 *         the base didn't name it, so it is kept and the incoming XMP recorded in
 *         `sidecar_divergences` (displaced and incoming digests equal) (#4692)
 *   400 — missing/invalid headers (including a malformed base), empty body, unsafe path,
 *         or a destination outside the library (e.g. through a symlinked folder)
 *   404 — library not found, no prior upload (neither maple_id nor device+phasset matched),
 *         or (with a base) the target path is not a live location of that asset
 *   413 — body exceeds 256 KB
 *   500 — the sidecar could not be written
 */
import {
  backupId,
  backupLibrary,
  backupLibraryId,
  isSafeRelPath,
} from "./backup-id.ts";
import { Elysia, t } from "elysia";
import type { ObjectId } from "../db/object-id.ts";
import {
  findLiveAssetIdByMapleId,
  findLiveAssetIdByPhassetLink,
} from "../db/repos/assets.repo.ts";
import { child as childLogger } from "../log.ts";
import path from "node:path";
import { xmpSidecarPath } from "../fs/xmp.ts";
import { sidecarStemClaimedBySibling } from "../fs/sidecar-ownership.ts";
import {
  parseSidecarBase,
  publishSidecarCas,
  publishSidecarIfAbsent,
} from "../backup/sidecar-cas.ts";
import {
  forgetSidecarDivergence,
  recordSidecarDivergence,
} from "../db/repos/sidecar-divergences.repo.ts";
import { isLiveLocationOfAsset } from "../db/repos/backup.repo.ts";

const log = childLogger("backup-sidecar");
const MAX_SIDECAR_BYTES = 256 * 1024; // 256 KB

/** The raw XMP bytes (Buffer or ArrayBuffer), or why they can't be stored. */
function readSidecarBody(
  body: unknown,
): { buf: Buffer } | { status: number; error: string } {
  const buf =
    body instanceof Uint8Array
      ? Buffer.from(body)
      : Buffer.from(body as ArrayBuffer);
  if (buf.byteLength === 0)
    return { status: 400, error: "body must not be empty" };
  if (buf.byteLength > MAX_SIDECAR_BYTES) {
    return { status: 413, error: "sidecar body exceeds 256 KB limit" };
  }
  return { buf };
}

/** The no-base rule: write only when no sidecar exists. Create-only and on
 * the shared write barrier, so it never lands over a compare-and-swap edit. */
async function publishLegacySidecar(
  finalPath: string,
  sidecarRelPath: string,
  buf: Buffer,
  libraryRoot: string,
  phid: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const outcome = await publishSidecarIfAbsent(
    finalPath,
    buf.toString("utf8"),
    libraryRoot,
  );
  if (outcome === "written" || outcome === "skipped") {
    log.debug({ phid, sidecarRelPath, outcome }, "sidecar legacy publish");
    return {
      status: 200,
      body:
        outcome === "written"
          ? { target_rel_path: sidecarRelPath }
          : { target_rel_path: sidecarRelPath, skipped: true },
    };
  }
  log.error({ phid, sidecarRelPath, outcome }, "sidecar legacy publish failed");
  return outcome.kind === "refused"
    ? { status: 400, body: { error: "sidecar path not allowed" } }
    : { status: 500, body: { error: "sidecar write failed" } };
}

interface BackupSidecarCasRequest {
  finalPath: string;
  targetRelPath: string;
  sidecarRelPath: string;
  xmp: string;
  baseHeader: string;
  assetId: ObjectId;
  libraryId: ObjectId;
  deviceId: string;
  libraryRoot: string;
  phid: string;
}

/** The compare-and-swap branch (#4719): publish, keep a displaced version in
 * `sidecar_divergences`, and say which of the outcomes happened. */
async function publishBackupSidecarCas(
  req: BackupSidecarCasRequest,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = parseSidecarBase(req.baseHeader);
  if (base === "invalid" || base === undefined) {
    return {
      status: 400,
      body: {
        error: 'X-Maple-Sidecar-Base must be a SHA-256 hex digest or "none"',
      },
    };
  }
  if (
    !(await isLiveLocationOfAsset(
      req.assetId,
      req.libraryId,
      req.targetRelPath,
    ))
  ) {
    return {
      status: 404,
      body: { error: "no prior upload of this asset at this path" },
    };
  }
  const outcome = await publishSidecarCas(
    req.finalPath,
    req.xmp,
    base,
    async (displaced) => {
      const id = await recordSidecarDivergence({
        assetId: req.assetId,
        libraryId: req.libraryId,
        sidecarRelPath: req.sidecarRelPath,
        deviceId: req.deviceId,
        baseSha256: base,
        displacedSha256: displaced.sha256,
        displacedXmp: displaced.xmp,
        incomingSha256: displaced.incomingSha256,
      });
      return () => forgetSidecarDivergence(id);
    },
    req.libraryRoot,
    await sidecarStemClaimedBySibling(
      path.join(req.libraryRoot, req.targetRelPath),
    ),
  );
  log.debug(
    {
      phid: req.phid,
      sidecarRelPath: req.sidecarRelPath,
      outcome: outcome.kind,
    },
    "sidecar compare-and-swap",
  );
  if (outcome.kind === "refused") {
    log.warn(
      {
        phid: req.phid,
        sidecarRelPath: req.sidecarRelPath,
        error: outcome.error,
      },
      "sidecar path refused",
    );
    return { status: 400, body: { error: "sidecar path not allowed" } };
  }
  if (outcome.kind === "error") {
    log.error(
      {
        phid: req.phid,
        sidecarRelPath: req.sidecarRelPath,
        error: outcome.error,
      },
      "sidecar compare-and-swap failed",
    );
    return { status: 500, body: { error: "sidecar write failed" } };
  }
  const body =
    outcome.kind === "written"
      ? { target_rel_path: req.sidecarRelPath }
      : { target_rel_path: req.sidecarRelPath, [outcome.kind]: true };
  return { status: 200, body };
}

export const backupSidecarRoutes = new Elysia().post(
  "/api/libraries/:libraryId/backup/sidecar",
  async ({ params, headers, body, set }) => {
    const libraryId = backupLibraryId(params.libraryId);
    if (libraryId instanceof Response) return libraryId;

    // Extract + validate required headers.
    const deviceId = headers["x-maple-device-id"];
    const phid = headers["x-maple-phasset-id"];
    const targetRelPath = headers["x-maple-target-rel-path"];
    // Optional content-hash dedup key. Primary lookup when present (#698).
    const mapleId = backupId(headers["x-maple-id"], "x-maple-id");
    if (mapleId instanceof Response) return mapleId;

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
      return { error: "no prior upload for this device and phasset" };
    }

    const sidecarBody = readSidecarBody(body);
    if ("status" in sidecarBody) {
      set.status = sidecarBody.status;
      return { error: sidecarBody.error };
    }
    const buf = sidecarBody.buf;

    const sidecarRelPath = xmpSidecarPath(targetRelPath);
    const finalPath = path.join(folder.path, sidecarRelPath);

    // Guard: ensure the computed absolute path is under the library root.
    if (
      !finalPath.startsWith(folder.path + path.sep) &&
      finalPath !== folder.path
    ) {
      set.status = 400;
      return { error: "path escape detected" };
    }

    const baseHeader = headers["x-maple-sidecar-base"];
    if (baseHeader !== undefined) {
      const result = await publishBackupSidecarCas({
        finalPath,
        targetRelPath,
        sidecarRelPath,
        xmp: buf.toString("utf8"),
        baseHeader,
        assetId: asset,
        libraryId,
        deviceId,
        libraryRoot: folder.path,
        phid,
      });
      set.status = result.status;
      return result.body;
    }

    // SKIP-IF-EXISTS: a dedup re-upload from a second device must not clobber
    // the first device's (possibly already-edited) sidecar (#698). Clients that
    // name a base take the compare-and-swap path above instead.
    const result = await publishLegacySidecar(
      finalPath,
      sidecarRelPath,
      buf,
      folder.path,
      phid,
    );
    set.status = result.status;
    return result.body;
  },
  {
    params: t.Object({ libraryId: t.String() }),
    body: t.Any(),
    // Force raw-byte parsing regardless of incoming Content-Type. iOS clients
    // post the XMP with `Content-Type: application/xml`, whose char-at-12 is
    // 'x' — colliding with `application/x-www-form-urlencoded` in Elysia's
    // fast switch (compose.mjs:438-444), which would hand the handler a
    // URLSearchParams-parsed object instead of an ArrayBuffer.
    parse: "arrayBuffer",
  },
);
