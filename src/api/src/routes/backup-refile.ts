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

import { Elysia, t } from 'elysia';
import * as nodePath from 'node:path';
import { resolveAndAuthorizePath } from './xmp-path-auth.ts';
import { assetsCollection } from '../db/client.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { assetPrimaryFileInfo } from '../indexer/images.repo.ts';
import { backupLocationSegments } from '../backup/location-segments.ts';
import { sanitizeLocationSegments, SCREENSHOT_DIR_SEGMENT } from '../backup/path-formatter.ts';
import { moveBackupAsset } from '../workers/migration/move-backup-asset.ts';
import { child as childLogger } from '../log.ts';
import type { AssetDoc, MetadataOverride } from '../db/schema.ts';
import type { WithId } from 'mongodb';

const log = childLogger('routes/backup-refile');

const MAX_PATHS = 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Prefer the 4-digit year already in the relative path prefix; fall back to
 * the DB captured_year. Returns null when neither is available (caller skips).
 */
function yearForDir(currentPath: string, capturedYear: number | null | undefined): string | null {
  const seg0 = currentPath.split('/')[0] ?? '';
  if (/^\d{4}$/.test(seg0)) return seg0;
  if (capturedYear != null && Number.isFinite(capturedYear)) {
    return String(Math.trunc(capturedYear)).padStart(4, '0');
  }
  return null;
}

/** ISO 3166-1 alpha-2 code for the United States (lowercased, as stored). */
const USA_COUNTRY_CODE = 'us';

/** Trim and null out empty/whitespace strings. */
function nonEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Leading civic prefix Nominatim attaches to some official locality names. */
const CIVIC_PREFIX = /^(?:City|Town|Village)\s+of\s+/i;

/** Strip a leading "City of " / "Town of " / "Village of " civic prefix. */
function stripCivicPrefix(name: string | null): string | null {
  if (name == null) return null;
  const stripped = name.replace(CIVIC_PREFIX, '').trim();
  return stripped.length > 0 ? stripped : name;
}

/**
 * Compute backup location segments directly from `metadata_override.place_text`.
 * Mirrors the logic in `backupLocationSegments` but reads from the IPTC
 * override fields so the refile uses the user's just-set geo selection rather
 * than the stale Nominatim-geocoded `doc.place` (which may not have been
 * updated by the async geocode stage yet).
 *
 * Returns `[]` when `place_text` is absent or has no usable country/state.
 */
export function geoSegmentsFromOverride(override: MetadataOverride | null | undefined): string[] {
  const pt = override?.place_text;
  if (!pt) return [];

  const countryCode = (nonEmpty(pt.country_code) ?? '').toLowerCase();
  const isUSA = countryCode === USA_COUNTRY_CODE;
  const state = nonEmpty(pt.state);
  const country = nonEmpty(pt.country);

  // USA → State, else Country (cross-fallback same as backupLocationSegments).
  const top = isUSA ? (state ?? country) : (country ?? state);
  if (!top) return [];

  const rawCity = nonEmpty(pt.city);
  const locality = stripCivicPrefix(rawCity);
  // NYC rename scoped to NY state in the USA (matches backupLocationSegments).
  const city =
    locality === 'New York' && isUSA && state === 'New York' ? 'New York City' : locality;

  return city ? [top, city] : [top];
}

/**
 * Compute the canonical geo dir (`<year>/<seg>[/<seg>]`) for a backup asset.
 *
 * Priority:
 *   1. Screenshot → `<year>/Screenshot` (same as computeCanonicalDir in refile-backups.ts).
 *   2. metadata_override.place_text → computed directly (geocode stage hasn't run yet).
 *   3. doc.place → Nominatim-geocoded fallback for assets without a fresh override.
 *
 * Returns null when the asset has no usable geo location.
 */
function geoDir(doc: WithId<AssetDoc>): string | null {
  const primary = assetPrimaryFileInfo(doc);
  if (!primary) return null;

  // Screenshot wins over location (same as computeCanonicalDir in refile-backups.ts).
  if (doc.is_screenshot) {
    const year = yearForDir(primary.path, doc.exif?.captured_year ?? null);
    return year ? `${year}/${SCREENSHOT_DIR_SEGMENT}` : null;
  }

  // Prefer the override place_text (set by batch-write, geocode hasn't run yet).
  const segs = (() => {
    const overrideSegs = geoSegmentsFromOverride(doc.metadata_override);
    if (overrideSegs.length > 0) return sanitizeLocationSegments(overrideSegs);
    return sanitizeLocationSegments(backupLocationSegments(doc.place ?? null));
  })();

  if (segs.length === 0) return null;
  const year = yearForDir(primary.path, doc.exif?.captured_year ?? null);
  return year ? `${year}/${segs.join('/')}` : null;
}

/** True when the asset is backup-origin and has a usable geo location. */
function isGeoBackupCandidate(doc: WithId<AssetDoc>): boolean {
  if (!doc.phasset_links || doc.phasset_links.length === 0) return false;
  const primary = assetPrimaryFileInfo(doc);
  if (!primary) return false;
  // Screenshot is always a candidate when backup-origin (it has a canonical dir).
  if (doc.is_screenshot) return true;
  const overrideSegs = geoSegmentsFromOverride(doc.metadata_override);
  if (overrideSegs.length > 0) return true;
  const segs = sanitizeLocationSegments(backupLocationSegments(doc.place ?? null));
  return segs.length > 0;
}

/**
 * True when relocating the asset would actually move it — i.e. its target geo
 * dir differs from its current dir. Mirrors `moveBackupAsset`'s skip condition
 * (`newDir === oldDir`, where `oldDir = primary.path`) so the offered count and
 * the count would not include assets already filed in their canonical folder.
 */
function wouldRelocate(doc: WithId<AssetDoc>): boolean {
  if (!isGeoBackupCandidate(doc)) return false;
  const target = geoDir(doc);
  if (!target) return false;
  const primary = assetPrimaryFileInfo(doc);
  return primary != null && primary.path !== target;
}

/**
 * Look up backup-origin asset docs for the given absolute paths.
 * Post-filters results by reconstructing each doc's absolute path from the
 * library map to prevent false matches on same-named files in other libraries.
 */
async function findGeoBackupDocs(
  absPaths: string[],
  libs: ReadonlyMap<string, string>,
): Promise<WithId<AssetDoc>[]> {
  if (absPaths.length === 0) return [];
  const filenames = [...new Set(absPaths.map((p) => nodePath.basename(p)).filter(Boolean))];
  const c = await assetsCollection();
  const docs = await c
    .find(
      {
        'fileinfo.filename': { $in: filenames },
        'phasset_links.0': { $exists: true },
      },
      {
        projection: {
          _id: 1,
          fileinfo: 1,
          maple_id: 1,
          apple_rendered_path: 1,
          place: 1,
          phasset_links: 1,
          'exif.captured_year': 1,
          is_screenshot: 1,
          'metadata_override.place_text': 1,
        },
      },
    )
    .toArray();

  // Reconstruct each doc's absolute path and intersect with the authorized set
  // so same-named files in unrelated libraries cannot be moved accidentally.
  const absPathSet = new Set(absPaths);
  return docs.filter((doc) => {
    const primary = assetPrimaryFileInfo(doc);
    if (!primary) return false;
    const root = libs.get(primary.library_id.toHexString());
    if (!root) return false;
    const absDocPath = nodePath.join(root, primary.path, primary.filename);
    return absPathSet.has(absDocPath);
  });
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

export const backupRefileRoutes = new Elysia({ name: 'backupRefile' })

  // ── Count ───────────────────────────────────────────────────────────────
  .post(
    '/api/backup/refile-count',
    async ({ body, set }) => {
      const { paths } = body;
      if (!Array.isArray(paths) || paths.length === 0) {
        set.status = 400;
        return { error: 'paths must be a non-empty array' };
      }
      if (paths.length > MAX_PATHS) {
        set.status = 400;
        return { error: `paths exceeds maximum of ${MAX_PATHS}` };
      }

      // Resolve each path through the auth jail (in parallel); drop unauthorized.
      const resolved = await Promise.all(paths.map((p) => resolveAndAuthorizePath(p)));
      const absPaths = resolved.flatMap((r) => (r.ok ? [r.data] : []));

      let libs: ReadonlyMap<string, string>;
      try {
        libs = await loadLibraryRoots();
      } catch {
        libs = new Map();
      }

      // A DB hiccup must not break the editor — return count:0 so the offer
      // simply doesn't surface, rather than 500-ing the panel.
      try {
        const docs = await findGeoBackupDocs(absPaths, libs);
        const count = docs.filter(wouldRelocate).length;
        return { count };
      } catch (err: unknown) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'backup-refile: count failed',
        );
        return { count: 0 };
      }
    },
    {
      body: RefileBodySchema,
      detail: {
        summary: 'Count geo-backup assets that would be relocated',
        tags: ['backup'],
      },
    },
  )

  // ── Refile ──────────────────────────────────────────────────────────────
  .post(
    '/api/backup/refile',
    async ({ body, set }) => {
      const { paths } = body;
      if (!Array.isArray(paths) || paths.length === 0) {
        set.status = 400;
        return { error: 'paths must be a non-empty array' };
      }
      if (paths.length > MAX_PATHS) {
        set.status = 400;
        return { error: `paths exceeds maximum of ${MAX_PATHS}` };
      }

      // Resolve each path through the auth jail (in parallel); drop unauthorized.
      const resolved = await Promise.all(paths.map((p) => resolveAndAuthorizePath(p)));
      const absPaths = resolved.flatMap((r) => (r.ok ? [r.data] : []));

      // Load library roots once — shared between findGeoBackupDocs (for
      // precise path matching) and the move loop (for building libRoot).
      let libs: ReadonlyMap<string, string>;
      try {
        libs = await loadLibraryRoots();
      } catch {
        libs = new Map();
      }

      const docs = await findGeoBackupDocs(absPaths, libs);

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
            ? (absPaths.find((p) => nodePath.basename(p) === primary.filename) ?? paths[0] ?? '')
            : (paths[0] ?? '');

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
          log.warn({ _id: String(doc._id) }, 'backup-refile: no library root for asset — skipping');
          results.push({
            path: representativePath,
            ok: false,
            error: 'library root not found',
          });
          continue;
        }

        try {
          // moveBackupAsset called WITHOUT extraSet — do NOT stamp backup_layout_version.
          // That stamp belongs to the bulk refile-backups migration only.
          const outcome = await moveBackupAsset(c, doc, libRoot, newDir);
          results.push({ path: representativePath, ok: true, outcome });
          const moved = outcome === 'moved';
          log.info(
            { _id: String(doc._id), outcome, newDir },
            moved ? 'backup-refile: asset relocated' : 'backup-refile: no move needed',
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ _id: String(doc._id), err: msg }, 'backup-refile: move failed');
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
        summary: 'Relocate geo-backup copies of edited assets into their canonical folder',
        tags: ['backup'],
      },
    },
  );
