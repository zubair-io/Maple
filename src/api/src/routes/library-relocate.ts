/**
 * On-demand library relocate routes for #1671 (Organize by location).
 *
 * Generalises the M3 backup re-file (#1630) to act on any library asset —
 * no `phasset_links` requirement.
 *
 * POST /api/library/relocate-count — count assets that would be relocated.
 * POST /api/library/relocate      — relocate each qualifying asset's primary
 *                                   file (+ its .xmp sidecar) into its
 *                                   canonical <year>/<State|Country>/<City>/
 *                                   folder under the library root.
 *
 * Both accept `{ addresses: string[] }` (slug:relPath) and resolve via the
 * existing `resolveAddress` jail. Assets with no resolvable geo location or
 * already in their canonical folder are silently skipped (count = 0 for them).
 * Per-asset error isolation: one failure never aborts the batch and never
 * leaves a half-moved file (crash-safe copy→verify→repoint→delete order).
 *
 * The `.xmp` sidecar is handled automatically by `moveBackupAsset` →
 * `planAndPlace` via `listPairedSidecars`, which already includes it as a
 * companion. No change to the move machinery is needed.
 *
 * Does NOT stamp `backup_layout_version` — that marker belongs to the bulk
 * geo-migration sweep, not targeted on-demand relocates.
 *
 * Spec: docs/superpowers/specs/2026-06-30-organize-by-location-design.md
 */

import { Elysia, t } from 'elysia';
import * as nodePath from 'node:path';
import { resolveAddressString } from '../library/address.ts';
import { assetsCollection } from '../db/client.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { assetPrimaryFileInfo } from '../indexer/images.repo.ts';

type FileInfo = NonNullable<AssetDoc['fileinfo']>[number];

/**
 * Return the primary active file info for an asset. Crucially, this does NOT
 * filter out entries with `missing_since` set (unlike assetPrimaryFileInfo),
 * because a missing-tagged file resolved on disk by the client is still eligible
 * for relocation (relocation will move the file and clear its missing tag).
 * Only filters out entries with `deleted_at` set.
 */
function assetActiveFileInfo(asset: Pick<AssetDoc, 'fileinfo'>): FileInfo | null {
  const list = asset.fileinfo;
  if (!list || list.length === 0) return null;
  for (const entry of list) {
    if (!entry.deleted_at) return entry;
  }
  return null;
}
import { isVideoFilename } from '../indexer/media-types.ts';
import { backupLocationSegments } from '../backup/location-segments.ts';
import { sanitizeLocationSegments, SCREENSHOT_DIR_SEGMENT } from '../backup/path-formatter.ts';
import { moveBackupAsset } from '../workers/migration/move-backup-asset.ts';
import { child as childLogger } from '../log.ts';
import type { AssetDoc, MetadataOverride } from '../db/schema.ts';
import type { Collection, WithId } from 'mongodb';
import {
  sidecarMetadataIndexHandler,
  SIDECAR_METADATA_INDEX_VERSION,
  SIDECAR_METADATA_INDEX_STAGE_NAME,
} from '../workers/stages/sidecar-metadata-index.ts';
import type { ImageDoc } from '../workers/run-stage.ts';

const log = childLogger('routes/library-relocate');

const MAX_ADDRESSES = 1000;

// ---------------------------------------------------------------------------
// Helpers (geo dir computation)
// ---------------------------------------------------------------------------

/**
 * Prefer the 4-digit year already in the relative path prefix; fall back to
 * the DB captured_year. Returns null when neither is available.
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
 * Compute location segments directly from `metadata_override.place_text` —
 * reads from the IPTC override fields so the relocate uses the user's just-set
 * geo selection rather than the stale Nominatim-geocoded `doc.place`.
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
 * Compute the canonical geo dir (`<year>/<seg>[/<seg>]`) for any asset.
 *
 * Priority:
 *   1. Screenshot → `<year>/Screenshot`.
 *   2. metadata_override.place_text → computed directly (geocode hasn't run).
 *   3. doc.place → Nominatim-geocoded fallback.
 *
 * Returns null when the asset has no usable geo location.
 */
function geoDir(doc: WithId<AssetDoc>): string | null {
  const primary = assetActiveFileInfo(doc);
  if (!primary) return null;

  // Screenshot wins over location.
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

/**
 * True when the asset has a resolvable geo location — regardless of whether it
 * has backup copies. This is the generalised predicate replacing the old
 * `isGeoBackupCandidate` which required `phasset_links`.
 */
function isGeoCandidate(doc: WithId<AssetDoc>): boolean {
  const primary = assetActiveFileInfo(doc);
  if (!primary) return false;
  // Videos are excluded until the full-name sidecar convention (clip.mov.xmp) is
  // handled by listPairedSidecars/planAndPlace — otherwise relocating a video
  // would strand its .mov.xmp sidecar in the old folder. Tracked by #1678.
  if (isVideoFilename(primary.filename)) return false;
  // Screenshot is always a candidate (it has a canonical dir).
  if (doc.is_screenshot) return true;
  const overrideSegs = geoSegmentsFromOverride(doc.metadata_override);
  if (overrideSegs.length > 0) return true;
  const segs = sanitizeLocationSegments(backupLocationSegments(doc.place ?? null));
  return segs.length > 0;
}

/**
 * True when relocating the asset would actually move it — i.e. its target geo
 * dir differs from its current dir.
 */
function wouldRelocate(doc: WithId<AssetDoc>): boolean {
  if (!isGeoCandidate(doc)) return false;
  const target = geoDir(doc);
  if (!target) return false;
  const primary = assetActiveFileInfo(doc);
  return primary != null && primary.path !== target;
}

/**
 * Look up asset docs for the given absolute paths. No `phasset_links` filter —
 * any indexed asset is eligible. Post-filters by reconstructing each doc's
 * absolute path to prevent false matches on same-named files in other libraries.
 */
async function findGeoDocs(
  absPaths: string[],
  libs: ReadonlyMap<string, string>,
): Promise<WithId<AssetDoc>[]> {
  if (absPaths.length === 0) return [];
  const filenames = [...new Set(absPaths.map((p) => nodePath.basename(p)).filter(Boolean))];
  const c = await assetsCollection();
  const docs = await c
    .find(
      { 'fileinfo.filename': { $in: filenames } },
      {
        projection: {
          _id: 1,
          fileinfo: 1,
          maple_id: 1,
          apple_rendered_path: 1,
          place: 1,
          'exif.captured_year': 1,
          is_screenshot: 1,
          'metadata_override.place_text': 1,
          stages: 1,
        },
      },
    )
    .toArray();

  // Reconstruct each doc's absolute path and intersect with the authorized set
  // so same-named files in unrelated libraries cannot be moved accidentally.
  const absPathSet = new Set(absPaths);
  const matchedDocs = docs.filter((doc) => {
    const primary = assetActiveFileInfo(doc);
    if (!primary) return false;
    const root = libs.get(primary.library_id.toHexString());
    if (!root) return false;
    const absDocPath = nodePath.join(root, primary.path, primary.filename);
    return absPathSet.has(absDocPath);
  });

  // Reconcile sidecar metadata on the fly for any dirty docs
  const dirtyDocs = matchedDocs.filter(
    (doc) =>
      doc.stages?.[SIDECAR_METADATA_INDEX_STAGE_NAME]?.version !== SIDECAR_METADATA_INDEX_VERSION,
  );

  if (dirtyDocs.length > 0) {
    const dirtyIds = dirtyDocs.map((d) => d._id);
    // Fetch full documents to avoid partial projection issues in the handler
    const fullDocs = await c.find({ _id: { $in: dirtyIds } }).toArray();
    const fullDocMap = new Map(fullDocs.map((d) => [d._id.toHexString(), d]));

    const bulkOps: any[] = [];
    const setDeep = (obj: any, path: string, value: any): void => {
      const parts = path.split('.');
      let current = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
          return; // Prevent prototype pollution
        }
        if (!(part in current) || current[part] == null) {
          current[part] = {};
        }
        current = current[part];
      }
      const lastPart = parts[parts.length - 1];
      if (lastPart !== '__proto__' && lastPart !== 'constructor' && lastPart !== 'prototype') {
        current[lastPart] = value;
      }
    };

    const CONCURRENCY_LIMIT = 4;
    for (let i = 0; i < dirtyDocs.length; i += CONCURRENCY_LIMIT) {
      const chunk = dirtyDocs.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.all(
        chunk.map(async (matchedDoc) => {
          const fullDoc = fullDocMap.get(matchedDoc._id.toHexString());
          if (!fullDoc) return;

          try {
            const result = await sidecarMetadataIndexHandler(fullDoc as ImageDoc, {
              log,
              signal: new AbortController().signal,
            });

            const stageState = {
              version: SIDECAR_METADATA_INDEX_VERSION,
              attempts: 0,
              last_error: null,
              processed_at: new Date(),
              dead: false,
            };

            matchedDoc.stages = matchedDoc.stages || {};
            matchedDoc.stages[SIDECAR_METADATA_INDEX_STAGE_NAME] = stageState;

            if ('patch' in result && result.patch) {
              bulkOps.push({
                updateOne: {
                  filter: { _id: matchedDoc._id },
                  update: {
                    $set: {
                      [`stages.${SIDECAR_METADATA_INDEX_STAGE_NAME}`]: stageState,
                      ...result.patch,
                    },
                  },
                },
              });
              for (const [key, value] of Object.entries(result.patch)) {
                setDeep(matchedDoc, key, value);
              }
            } else if ('skip' in result) {
              const skipState = {
                ...stageState,
                last_error: `skip: ${result.skip}`,
              };
              matchedDoc.stages[SIDECAR_METADATA_INDEX_STAGE_NAME] = skipState;
              bulkOps.push({
                updateOne: {
                  filter: { _id: matchedDoc._id },
                  update: {
                    $set: {
                      [`stages.${SIDECAR_METADATA_INDEX_STAGE_NAME}`]: skipState,
                    },
                  },
                },
              });
            } else {
              // Success but no patch or empty patch. Mark completed to prevent infinite loops.
              bulkOps.push({
                updateOne: {
                  filter: { _id: matchedDoc._id },
                  update: {
                    $set: {
                      [`stages.${SIDECAR_METADATA_INDEX_STAGE_NAME}`]: stageState,
                    },
                  },
                },
              });
            }
          } catch (err: unknown) {
            log.warn(
              {
                _id: String(matchedDoc._id),
                err: err instanceof Error ? err.message : String(err),
              },
              'library-relocate: failed to reconcile sidecar metadata on the fly',
            );
          }
        }),
      );
    }

    if (bulkOps.length > 0) {
      await c.bulkWrite(bulkOps);
    }
  }

  return matchedDocs;
}

/**
 * After a `moved` outcome, re-read the asset's repointed primary fileinfo and
 * report whether a collision auto-rename occurred — i.e. its new filename
 * differs from the one we started with. `moveBackupAsset` itself can't tell a
 * plain move from a rename, so we compare here rather than guess.
 */
async function didRename(
  coll: Collection<AssetDoc>,
  id: WithId<AssetDoc>['_id'],
  originalFilename: string,
): Promise<boolean> {
  const fresh = await coll.findOne({ _id: id }, { projection: { fileinfo: 1 } });
  if (!fresh) return false;
  const primary = assetActiveFileInfo(fresh);
  return primary != null && primary.filename !== originalFilename;
}

// ---------------------------------------------------------------------------
// Shared request schema
// ---------------------------------------------------------------------------

const RelocateBodySchema = t.Object({
  addresses: t.Array(t.String()),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const libraryRelocateRoutes = new Elysia({ name: 'libraryRelocate' })

  // ── Count ───────────────────────────────────────────────────────────────
  .post(
    '/api/library/relocate-count',
    async ({ body, set }) => {
      const { addresses } = body;
      if (!Array.isArray(addresses) || addresses.length === 0) {
        set.status = 400;
        return { error: 'addresses must be a non-empty array' };
      }
      if (addresses.length > MAX_ADDRESSES) {
        set.status = 400;
        return { error: `addresses exceeds maximum of ${MAX_ADDRESSES}` };
      }

      // Resolve each address through the library jail (in parallel); drop failures.
      const resolved = await Promise.all(
        addresses.map(async (addr) => {
          try {
            const r = await resolveAddressString(addr);
            return r.absPath;
          } catch {
            return null;
          }
        }),
      );
      const absPaths = resolved.filter((p): p is string => p !== null);

      let libs: ReadonlyMap<string, string>;
      try {
        libs = await loadLibraryRoots();
      } catch {
        libs = new Map();
      }

      // A DB hiccup must not break the editor — return count:0 so the offer
      // simply doesn't surface, rather than 500-ing the panel.
      try {
        const docs = await findGeoDocs(absPaths, libs);
        const count = docs.filter(wouldRelocate).length;
        return { count };
      } catch (err: unknown) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'library-relocate: count failed',
        );
        return { count: 0 };
      }
    },
    {
      body: RelocateBodySchema,
      detail: {
        summary: 'Count assets that would be relocated into their location folder',
        tags: ['library'],
      },
    },
  )

  // ── Relocate ─────────────────────────────────────────────────────────────
  .post(
    '/api/library/relocate',
    async ({ body, set }) => {
      const { addresses } = body;
      if (!Array.isArray(addresses) || addresses.length === 0) {
        set.status = 400;
        return { error: 'addresses must be a non-empty array' };
      }
      if (addresses.length > MAX_ADDRESSES) {
        set.status = 400;
        return { error: `addresses exceeds maximum of ${MAX_ADDRESSES}` };
      }

      // Resolve each address through the library jail (in parallel); drop failures.
      // Keep an absolute-path → original-client-address map so per-asset results
      // echo the exact address string the client sent.
      const resolved = await Promise.all(
        addresses.map(async (addr) => {
          try {
            const r = await resolveAddressString(addr);
            return { addr, absPath: r.absPath };
          } catch {
            return { addr, absPath: null };
          }
        }),
      );
      const absPaths: string[] = [];
      const absToClient = new Map<string, string>();
      for (const { addr, absPath } of resolved) {
        if (absPath !== null) {
          absPaths.push(absPath);
          if (!absToClient.has(absPath)) absToClient.set(absPath, addr);
        }
      }

      // Load library roots once — shared between findGeoDocs (for precise path
      // matching) and the move loop (for building libRoot).
      let libs: ReadonlyMap<string, string>;
      try {
        libs = await loadLibraryRoots();
      } catch {
        libs = new Map();
      }

      const docs = await findGeoDocs(absPaths, libs);

      const c = await assetsCollection();
      const results: Array<{
        address: string;
        ok: boolean;
        outcome?: string;
        renamed?: boolean;
        error?: string;
      }> = [];

      for (const doc of docs) {
        const primary = assetActiveFileInfo(doc);
        const libRoot = primary ? libs.get(primary.library_id.toHexString()) : undefined;
        // Reconstruct the doc's absolute path (unique per asset — same way
        // findGeoDocs matches) to recover the EXACT client address string.
        // Fall back to '' rather than addresses[0]: on a miss (e.g. no libRoot,
        // so docAbsPath is '') a wrong-asset attribution would be worse than none.
        const docAbsPath =
          primary && libRoot ? nodePath.join(libRoot, primary.path, primary.filename) : '';
        const representativeAddress = absToClient.get(docAbsPath) ?? '';

        if (!isGeoCandidate(doc)) {
          // No resolvable geo location — silently skip.
          continue;
        }

        const newDir = geoDir(doc);
        if (!newDir) {
          continue;
        }

        if (!libRoot) {
          log.warn(
            { _id: String(doc._id) },
            'library-relocate: no library root for asset — skipping',
          );
          results.push({
            address: representativeAddress,
            ok: false,
            error: 'library root not found',
          });
          continue;
        }

        try {
          // moveBackupAsset called WITHOUT extraSet — do NOT stamp backup_layout_version.
          // The sidecar is included automatically via listPairedSidecars in planAndPlace.
          const originalFilename = primary?.filename;
          const outcome = await moveBackupAsset(c, doc, libRoot, newDir);
          // `renamed` is only meaningful for an actual move. moveBackupAsset can't
          // report a collision auto-rename, so re-read the repointed fileinfo and
          // compare the new filename to the one we started with.
          const renamed =
            outcome === 'moved' && originalFilename != null
              ? await didRename(c, doc._id, originalFilename)
              : false;
          results.push({
            address: representativeAddress,
            ok: true,
            outcome,
            renamed,
          });
          log.info(
            { _id: String(doc._id), outcome, newDir, renamed },
            outcome === 'moved'
              ? 'library-relocate: asset relocated'
              : 'library-relocate: no move needed',
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ _id: String(doc._id), err: msg }, 'library-relocate: move failed');
          results.push({
            address: representativeAddress,
            ok: false,
            error: msg,
          });
        }
      }

      const hasErrors = results.some((r) => !r.ok);
      set.status = hasErrors ? 207 : 200;
      return { results };
    },
    {
      body: RelocateBodySchema,
      detail: {
        summary: 'Relocate assets into their canonical location folder (year/state/city)',
        tags: ['library'],
      },
    },
  );
