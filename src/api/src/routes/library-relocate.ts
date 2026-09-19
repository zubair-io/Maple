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
 * The `.xmp` sidecar is handled automatically by `relocateGeoAsset` (#2667,
 * `library/relocate-geo.ts` — built on the shared `relocateAsset` primitive)
 * via `listPairedSidecars`, which includes it as a companion — for both the
 * stem-swap convention images use (`photo.dng` → `photo.xmp`) and the
 * full-name convention videos use (`clip.mov` → `clip.mov.xmp`). Videos are
 * relocation candidates the same as any other asset (#1678).
 *
 * Does NOT stamp `backup_layout_version` — that marker belongs to the bulk
 * geo-migration sweep, not targeted on-demand relocates.
 *
 * Spec: docs/superpowers/specs/2026-06-30-organize-by-location-design.md
 */

import { Elysia, t } from 'elysia';
import * as nodePath from 'node:path';
import { resolveAddressString } from '../library/address.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { geoSegmentsFromOverride } from './library-relocate-helper.ts';

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
import { backupLocationSegments } from '../backup/location-segments.ts';
import { sanitizeLocationSegments, SCREENSHOT_DIR_SEGMENT } from '../backup/path-formatter.ts';
import { relocateGeoAsset } from '../library/relocate-geo.ts';
import { child as childLogger } from '../log.ts';
import type { AssetDoc } from '../db/schema.ts';
import type { ObjectId, WithId } from 'mongodb';
import {
  findRelocateCandidatesByFilenames,
  type RelocateCandidateRow,
} from '../db/sqlite/repos/assets.by-filename.ts';
import { loadAssetLocationView } from '../db/sqlite/repos/assets.locations.repo.ts';
import { loadStageDocuments } from '../db/sqlite/repos/stage-documents.repo.ts';
import {
  recordOffClaimStageResults,
  type OffClaimStageResult,
} from '../db/sqlite/repos/stage-state.repo.ts';
import {
  sidecarMetadataIndexHandler,
  SIDECAR_METADATA_INDEX_VERSION,
  SIDECAR_METADATA_INDEX_STAGE_NAME,
} from '../workers/stages/sidecar-metadata-index.ts';

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

/**
 * Compute the canonical geo dir (`<year>/<seg>[/<seg>]`) for any asset.
 *
 * Priority:
 *   1. Screenshot → `<year>/Screenshot`.
 *   2. metadata_override.place_text → computed directly (geocode hasn't run).
 *   3. doc.place → Nominatim-geocoded fallback.
 *
 * Falls back to <year>/Misc when the asset has no usable geo location.
 */
function geoDir(doc: WithId<AssetDoc>): string | null {
  const primary = assetActiveFileInfo(doc);
  if (!primary) return null;

  // Screenshot wins over location.
  const isScreenshot = doc.metadata_override?.is_screenshot ?? doc.is_screenshot;
  if (isScreenshot) {
    const year = yearForDir(primary.path, doc.exif?.captured_year ?? null);
    return year ? `${year}/${SCREENSHOT_DIR_SEGMENT}` : null;
  }

  // Prefer the override place_text (set by batch-write, geocode hasn't run yet).
  const segs = (() => {
    const overrideSegs = geoSegmentsFromOverride(doc.metadata_override);
    if (overrideSegs.length > 0) return sanitizeLocationSegments(overrideSegs);
    return sanitizeLocationSegments(backupLocationSegments(doc.place ?? null));
  })();

  const year = yearForDir(primary.path, doc.exif?.captured_year ?? null);
  if (!year) return null;

  if (segs.length === 0) {
    return `${year}/Misc`;
  }
  return `${year}/${segs.join('/')}`;
}

/**
 * True when the asset is a candidate for relocation (under geo or Misc folders)
 * — regardless of whether it has backup copies. This is the generalised predicate
 * replacing the old `isGeoBackupCandidate` which required `phasset_links`.
 */
function isGeoCandidate(doc: WithId<AssetDoc>): boolean {
  return assetActiveFileInfo(doc) !== null;
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
 * Keep only the candidates whose reconstructed absolute path is one the caller
 * actually authorised.
 *
 * The lookup is by basename, so it can return same-named files from unrelated
 * libraries; rebuilding each candidate's absolute path from its library root and
 * intersecting with the resolved set is what stops one of those being moved.
 */
function matchByAbsPath(
  candidates: readonly RelocateCandidateRow[],
  libs: ReadonlyMap<string, string>,
  absPaths: ReadonlySet<string>,
): RelocateCandidateRow[] {
  return candidates.filter((candidate) => {
    const primary = assetActiveFileInfo(candidate.doc);
    if (!primary) return false;
    const root = libs.get(primary.library_id.toHexString());
    if (!root) return false;
    return absPaths.has(nodePath.join(root, primary.path, primary.filename));
  });
}

/** How many sidecars are parsed at once during an on-the-fly reconcile. */
const RECONCILE_CONCURRENCY = 4;

/**
 * Bring these assets' stored metadata up to date with their sidecars, by running
 * the `sidecar-metadata-index` handler here instead of waiting for its poll
 * loop.
 *
 * Without this the route would decide an asset's canonical folder from a
 * `place_text` the user has already superseded — the batch metadata editor
 * writes the sidecar and marks the stage dirty, and the relocate offer surfaces
 * straight afterwards. A failed reconcile is logged and the asset is left out of
 * the writeback entirely, so its stage row stays below target and the poll loop
 * retries it properly rather than the route marking it handled.
 */
async function reconcileSidecarMetadata(ids: readonly ObjectId[]): Promise<void> {
  const docs = [...(await loadStageDocuments(ids.map((id) => id.toHexString()))).values()];
  const outcomes: OffClaimStageResult[] = [];

  for (let i = 0; i < docs.length; i += RECONCILE_CONCURRENCY) {
    await Promise.all(
      docs.slice(i, i + RECONCILE_CONCURRENCY).map(async (doc) => {
        const assetId = doc._id.toHexString();
        try {
          const result = await sidecarMetadataIndexHandler(doc, {
            log,
            signal: new AbortController().signal,
          });
          outcomes.push(
            'patch' in result
              ? { assetId, patch: result.patch, invalidates: result.invalidates }
              : { assetId, skipReason: 'skip' in result ? result.skip : undefined },
          );
        } catch (err: unknown) {
          log.warn(
            { _id: assetId, err: err instanceof Error ? err.message : String(err) },
            'library-relocate: failed to reconcile sidecar metadata on the fly',
          );
        }
      }),
    );
  }

  await recordOffClaimStageResults(
    { name: SIDECAR_METADATA_INDEX_STAGE_NAME, targetVersion: SIDECAR_METADATA_INDEX_VERSION },
    outcomes,
  );
}

/**
 * The asset docs behind the given absolute paths, with their sidecar metadata
 * reconciled first. No `phasset_links` filter — any indexed asset is eligible.
 */
async function findGeoDocs(
  absPaths: string[],
  libs: ReadonlyMap<string, string>,
): Promise<WithId<AssetDoc>[]> {
  if (absPaths.length === 0) return [];
  const filenames = [...new Set(absPaths.map((p) => nodePath.basename(p)).filter(Boolean))];
  const absPathSet = new Set(absPaths);
  const load = async (): Promise<RelocateCandidateRow[]> =>
    matchByAbsPath(
      await findRelocateCandidatesByFilenames(filenames, SIDECAR_METADATA_INDEX_STAGE_NAME),
      libs,
      absPathSet,
    );

  const matched = await load();
  const dirty = matched.filter(
    (candidate) => candidate.sidecarStageVersion !== SIDECAR_METADATA_INDEX_VERSION,
  );
  if (dirty.length === 0) return matched.map((candidate) => candidate.doc);

  await reconcileSidecarMetadata(dirty.map((candidate) => candidate.doc._id));
  // Re-read rather than fold the handler's output into the copies already in
  // hand. The handler returns statements now, so the rows are the only faithful
  // account of what it wrote — and replaying them in memory is exactly the kind
  // of second implementation that drifts.
  return (await load()).map((candidate) => candidate.doc);
}

/**
 * After a `moved` outcome, re-read the asset's repointed primary location and
 * report whether a collision auto-rename occurred — i.e. its new filename
 * differs from the one we started with. `relocateGeoAsset` itself can't tell a
 * plain move from a rename, so we compare here rather than guess.
 */
async function didRename(id: ObjectId, originalFilename: string): Promise<boolean> {
  const fresh = await loadAssetLocationView(id);
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
          // relocateGeoAsset never stamps backup_layout_version — that marker
          // belongs to the bulk geo-migration sweep, not this on-demand route.
          // The sidecar (and, if present, the apple_rendered_path companion)
          // is included automatically (#2667).
          const originalFilename = primary?.filename;
          const outcome = await relocateGeoAsset(doc, libRoot, newDir, primary!);
          // `renamed` is only meaningful for an actual move. relocateGeoAsset
          // can't report a collision auto-rename directly, so re-read the
          // repointed location and compare the new filename to the one we
          // started with.
          const renamed =
            outcome === 'moved' && originalFilename != null
              ? await didRename(doc._id, originalFilename)
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
