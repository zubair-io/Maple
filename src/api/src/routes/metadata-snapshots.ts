/**
 * POST /api/metadata/snapshots — return the effective XMP metadata snapshot
 * for a batch of asset paths, reading from the DB's `metadata_override` and
 * `exif` fields.
 *
 * The response carries only the fields with a non-null effective value —
 * absent keys mean "not set". Paths that fail auth or are absent from the DB
 * return `{ path, metadata: {} }`.
 *
 * Used by the Batch Metadata panel (#1615) to detect "mixed" state across a
 * selection: any field that differs across the returned snapshots is mixed.
 *
 * Spec: task-1-brief.md (Task 1 of the #1615 full-fidelity mixed-detection
 * feature).
 */

import { Elysia, t } from 'elysia';
import * as nodePath from 'node:path';
import { resolveAndAuthorizePath } from './xmp-path-auth.ts';
import { assetsCollection } from '../db/client.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { assetAbsPath } from '../indexer/images.repo.ts';
import type { AssetDoc } from '../db/schema.ts';

// ---------------------------------------------------------------------------
// XmpSnapshot type
// ---------------------------------------------------------------------------

type XmpSnapshot = Partial<{
  gpsLatitude: number;
  gpsLongitude: number;
  gpsAltitude: number;
  dateTimeOriginal: string;
  timeZone: string;
  sublocation: string;
  city: string;
  state: string;
  country: string;
  countryCode: string;
  keywords: string[];
  title: string;
  caption: string;
  headline: string;
  instructions: string;
  creator: string;
  creatorJobTitle: string;
  copyrightNotice: string;
  copyrightStatus: 'unknown' | 'copyrighted' | 'public-domain';
  usageTerms: string;
  credit: string;
  source: string;
}>;

// ---------------------------------------------------------------------------
// Pure mapping helper
// ---------------------------------------------------------------------------

/**
 * Map a doc's `metadata_override` + `exif` fields to the flat XmpSnapshot
 * shape the panel expects. Only includes keys whose effective value is
 * non-null and non-undefined. Keywords: skip if null, include if non-null
 * array (even empty).
 */
export function overrideToXmpSnapshot(
  doc: Pick<AssetDoc, 'exif' | 'metadata_override'>,
): XmpSnapshot {
  const override = doc.metadata_override ?? undefined;
  const exif = doc.exif ?? undefined;

  const snapshot: XmpSnapshot = {};

  // GPS
  const gpsLat = override?.gps?.lat ?? exif?.gps?.lat;
  if (gpsLat != null) snapshot.gpsLatitude = gpsLat;

  const gpsLng = override?.gps?.lng ?? exif?.gps?.lng;
  if (gpsLng != null) snapshot.gpsLongitude = gpsLng;

  if (override?.gps?.alt != null) snapshot.gpsAltitude = override.gps.alt;

  // Date/time
  const capturedAt = override?.captured_at ?? exif?.captured_at;
  if (capturedAt != null) snapshot.dateTimeOriginal = capturedAt;

  if (override?.time_zone != null) snapshot.timeZone = override.time_zone;

  // Place text — only from override (no exif equivalent)
  if (override?.place_text?.sublocation != null)
    snapshot.sublocation = override.place_text.sublocation;
  if (override?.place_text?.city != null) snapshot.city = override.place_text.city;
  if (override?.place_text?.state != null) snapshot.state = override.place_text.state;
  if (override?.place_text?.country != null) snapshot.country = override.place_text.country;
  if (override?.place_text?.country_code != null)
    snapshot.countryCode = override.place_text.country_code;

  // Keywords: skip when null, include when non-null array (even empty)
  if (override?.keywords !== null && override?.keywords !== undefined) {
    snapshot.keywords = override.keywords;
  }

  // IPTC / XMP text fields
  if (override?.title != null) snapshot.title = override.title;
  if (override?.caption != null) snapshot.caption = override.caption;
  if (override?.headline != null) snapshot.headline = override.headline;
  if (override?.instructions != null) snapshot.instructions = override.instructions;
  if (override?.creator != null) snapshot.creator = override.creator;
  if (override?.creator_job_title != null) snapshot.creatorJobTitle = override.creator_job_title;
  if (override?.copyright_notice != null) snapshot.copyrightNotice = override.copyright_notice;
  if (override?.copyright_status != null) snapshot.copyrightStatus = override.copyright_status;
  if (override?.usage_terms != null) snapshot.usageTerms = override.usage_terms;
  if (override?.credit != null) snapshot.credit = override.credit;
  if (override?.source != null) snapshot.source = override.source;

  return snapshot;
}

// ---------------------------------------------------------------------------
// DB lookup
// ---------------------------------------------------------------------------

/**
 * Look up asset docs for the given absolute paths.
 * Post-filters results by reconstructing each doc's absolute path from the
 * library map to prevent false matches on same-named files in other libraries.
 * Returns a Map from absPath → doc.
 */
async function findAssetDocs(
  absPaths: string[],
  libs: ReadonlyMap<string, string>,
): Promise<Map<string, Pick<AssetDoc, 'exif' | 'metadata_override' | 'fileinfo'>>> {
  if (absPaths.length === 0) return new Map();
  const filenames = [...new Set(absPaths.map((p) => nodePath.basename(p)).filter(Boolean))];
  const c = await assetsCollection();
  const docs = await c
    .find(
      { 'fileinfo.filename': { $in: filenames } },
      { projection: { metadata_override: 1, exif: 1, fileinfo: 1 } },
    )
    .toArray();

  const absPathSet = new Set(absPaths);
  const result = new Map<string, Pick<AssetDoc, 'exif' | 'metadata_override' | 'fileinfo'>>();

  for (const doc of docs) {
    // Reconstruct the absolute path via the shared helper so path composition
    // (POSIX-split of fileinfo.path, platform-correct join) stays consistent
    // with the rest of the codebase. Returns null when the library is
    // unregistered or the asset has no live fileinfo entry.
    const absDocPath = assetAbsPath(doc, libs);
    if (!absDocPath) continue;
    if (absPathSet.has(absDocPath) && !result.has(absDocPath)) {
      result.set(absDocPath, doc);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const MAX_PATHS = 1000;

export const metadataSnapshotsRoutes = new Elysia({
  name: 'metadataSnapshots',
}).post(
  '/api/metadata/snapshots',
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

    // Authorize each path in parallel; drop unauthorized (return empty snapshot).
    const authResults = await Promise.all(paths.map((p) => resolveAndAuthorizePath(p)));

    // Build a set of authorized absolute paths (preserving order via index).
    const authorizedAbsPaths: Array<string | null> = authResults.map((r) => (r.ok ? r.data : null));
    const absPaths = authorizedAbsPaths.filter((p): p is string => p !== null);

    let libs: ReadonlyMap<string, string>;
    try {
      libs = await loadLibraryRoots();
    } catch {
      libs = new Map();
    }

    let docMap: Map<string, Pick<AssetDoc, 'exif' | 'metadata_override' | 'fileinfo'>>;
    try {
      docMap = await findAssetDocs(absPaths, libs);
    } catch {
      // DB unreachable → return empty snapshots for all paths (safe default)
      docMap = new Map();
    }

    // Build response in request-path order.
    const snapshots = paths.map((originalPath, i) => {
      const absPath = authorizedAbsPaths[i];
      // Failed auth or no abs path → empty metadata.
      if (!absPath) return { path: originalPath, metadata: {} };
      const doc = docMap.get(absPath);
      // Not found in DB → empty metadata.
      if (!doc) return { path: originalPath, metadata: {} };
      return { path: originalPath, metadata: overrideToXmpSnapshot(doc) };
    });

    return { snapshots };
  },
  {
    body: t.Object({
      paths: t.Array(t.String()),
    }),
    detail: {
      summary: 'Return effective XMP metadata snapshots for a batch of asset paths',
      tags: ['metadata'],
    },
  },
);
