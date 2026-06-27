/**
 * On-demand backup re-file routes for Batch Metadata M3 (#1630).
 *
 * POST /api/backup/refile-count — count geo-backup assets that would be relocated.
 * POST /api/backup/refile      — relocate each affected asset's geo-backup copy.
 *
 * Both accept `{ paths: string[] }` — the sidecar-adjacent asset paths from the
 * M2 batch-write payload. Only backup-origin assets (`phasset_links` non-empty)
 * with a usable geo location (`backupLocationSegments` returns a non-empty array)
 * are acted upon; others are silently skipped. Returns N=0 for non-backup libraries.
 *
 * Reuses `backupLocationSegments` + `sanitizeLocationSegments` for path logic and
 * `moveBackupAsset` for the crash-safe copy→verify→repoint→delete move.
 * Does NOT stamp `backup_layout_version` — that marker belongs to the bulk
 * `refile-backups` migration sweep, not to targeted on-demand relocates.
 *
 * Spec: docs/superpowers/plans/2026-06-27-batch-metadata-m3-backup-refile.md
 * §"Task 1: API — refile-count and refile-by-asset routes"
 */

import { Elysia, t } from "elysia";
import * as nodePath from "node:path";
import { resolveAndAuthorizePath } from "./xmp-path-auth.ts";
import { assetsCollection } from "../db/client.ts";
import { loadLibraryRoots } from "../indexer/libraries.cache.ts";
import { assetPrimaryFileInfo } from "../indexer/images.repo.ts";
import { backupLocationSegments } from "../backup/location-segments.ts";
import { sanitizeLocationSegments } from "../backup/path-formatter.ts";
import { moveBackupAsset } from "../workers/migration/move-backup-asset.ts";
import { child as childLogger } from "../log.ts";
import type { AssetDoc } from "../db/schema.ts";
import type { WithId } from "mongodb";

const log = childLogger("routes/backup-refile");

const MAX_PATHS = 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Prefer the 4-digit year already in the relative path prefix; fall back to
 * the DB captured_year. Returns null when neither is available (caller skips).
 */
function yearForDir(
  currentPath: string,
  capturedYear: number | null | undefined,
): string | null {
  const seg0 = currentPath.split("/")[0] ?? "";
  if (/^\d{4}$/.test(seg0)) return seg0;
  if (capturedYear != null && Number.isFinite(capturedYear)) {
    return String(Math.trunc(capturedYear)).padStart(4, "0");
  }
  return null;
}

/**
 * Compute the canonical geo dir (`<year>/<seg>[/<seg>]`) for a backup asset.
 * Returns null when the asset has no usable geo location.
 */
function geoDir(doc: WithId<AssetDoc>): string | null {
  const primary = assetPrimaryFileInfo(doc);
  if (!primary) return null;
  const segs = sanitizeLocationSegments(
    backupLocationSegments(doc.place ?? null),
  );
  if (segs.length === 0) return null;
  const year = yearForDir(primary.path, doc.exif?.captured_year ?? null);
  if (!year) return null;
  return `${year}/${segs.join("/")}`;
}

/** True when the asset is backup-origin and has a usable geo location. */
function isGeoBackupCandidate(doc: WithId<AssetDoc>): boolean {
  if (!doc.phasset_links || doc.phasset_links.length === 0) return false;
  const primary = assetPrimaryFileInfo(doc);
  if (!primary) return false;
  const segs = sanitizeLocationSegments(
    backupLocationSegments(doc.place ?? null),
  );
  return segs.length > 0;
}

/** Look up backup-origin asset docs for the given absolute paths. */
async function findGeoBackupDocs(
  absPaths: string[],
): Promise<WithId<AssetDoc>[]> {
  if (absPaths.length === 0) return [];
  const filenames = [
    ...new Set(absPaths.map((p) => nodePath.basename(p)).filter(Boolean)),
  ];
  const c = await assetsCollection();
  return c
    .find(
      {
        "fileinfo.filename": { $in: filenames },
        "phasset_links.0": { $exists: true },
      },
      {
        projection: {
          _id: 1,
          fileinfo: 1,
          maple_id: 1,
          apple_rendered_path: 1,
          place: 1,
          phasset_links: 1,
          "exif.captured_year": 1,
        },
      },
    )
    .toArray();
}

// ---------------------------------------------------------------------------
// Shared request schema
// ---------------------------------------------------------------------------

const RefileBodySchema = t.Object({
  paths: t.Array(t.String()),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const backupRefileRoutes = new Elysia({ name: "backupRefile" })

  // ── Count ───────────────────────────────────────────────────────────────
  .post(
    "/api/backup/refile-count",
    async ({ body, set }) => {
      const { paths } = body;
      if (!Array.isArray(paths) || paths.length === 0) {
        set.status = 400;
        return { error: "paths must be a non-empty array" };
      }
      if (paths.length > MAX_PATHS) {
        set.status = 400;
        return { error: `paths exceeds maximum of ${MAX_PATHS}` };
      }

      // Resolve each path through the auth jail; silently drop unauthorized.
      const absPaths: string[] = [];
      for (const p of paths) {
        const auth = await resolveAndAuthorizePath(p);
        if (auth.ok) absPaths.push(auth.data);
      }

      const docs = await findGeoBackupDocs(absPaths);
      const count = docs.filter((d) => isGeoBackupCandidate(d)).length;

      return { count };
    },
    {
      body: RefileBodySchema,
      detail: {
        summary: "Count geo-backup assets that would be relocated",
        tags: ["backup"],
      },
    },
  )

  // ── Refile ──────────────────────────────────────────────────────────────
  .post(
    "/api/backup/refile",
    async ({ body, set }) => {
      const { paths } = body;
      if (!Array.isArray(paths) || paths.length === 0) {
        set.status = 400;
        return { error: "paths must be a non-empty array" };
      }
      if (paths.length > MAX_PATHS) {
        set.status = 400;
        return { error: `paths exceeds maximum of ${MAX_PATHS}` };
      }

      // Resolve each path through the auth jail; silently drop unauthorized.
      const absPaths: string[] = [];
      for (const p of paths) {
        const auth = await resolveAndAuthorizePath(p);
        if (auth.ok) absPaths.push(auth.data);
      }

      const docs = await findGeoBackupDocs(absPaths);

      let libs: ReadonlyMap<string, string>;
      try {
        libs = await loadLibraryRoots();
      } catch {
        libs = new Map();
      }

      const c = await assetsCollection();
      const results: Array<{
        path: string;
        ok: boolean;
        outcome?: string;
        error?: string;
      }> = [];

      for (const doc of docs) {
        const primary = assetPrimaryFileInfo(doc);
        // Pick a representative input path (best-effort; used only for the response label).
        const representativePath =
          primary != null
            ? (absPaths.find(
                (p) => nodePath.basename(p) === primary.filename,
              ) ??
              paths[0] ??
              "")
            : (paths[0] ?? "");

        if (!isGeoBackupCandidate(doc)) {
          // Not a geo-backup asset — silently skip (not an error).
          continue;
        }

        const newDir = geoDir(doc);
        if (!newDir) {
          continue;
        }

        const libRoot = libs.get(primary!.library_id.toHexString());
        if (!libRoot) {
          log.warn(
            { _id: String(doc._id) },
            "backup-refile: no library root for asset — skipping",
          );
          results.push({
            path: representativePath,
            ok: false,
            error: "library root not found",
          });
          continue;
        }

        try {
          // moveBackupAsset called WITHOUT extraSet — do NOT stamp backup_layout_version.
          // That stamp belongs to the bulk refile-backups migration only.
          const outcome = await moveBackupAsset(c, doc, libRoot, newDir);
          results.push({ path: representativePath, ok: true, outcome });
          log.info(
            { _id: String(doc._id), outcome, newDir },
            "backup-refile: asset relocated",
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(
            { _id: String(doc._id), err: msg },
            "backup-refile: move failed",
          );
          results.push({ path: representativePath, ok: false, error: msg });
        }
      }

      const hasErrors = results.some((r) => !r.ok);
      set.status = hasErrors ? 207 : 200;
      return { results };
    },
    {
      body: RefileBodySchema,
      detail: {
        summary:
          "Relocate geo-backup copies of edited assets into their canonical folder",
        tags: ["backup"],
      },
    },
  );
