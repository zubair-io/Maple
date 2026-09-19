/**
 * `sidecar-metadata-index` stage (#1580 — Batch Metadata M1).
 *
 * Reconciles `metadata_override` from the XMP sidecar, off the request path.
 * Idempotent and crash-safe: a re-run re-reads the sidecar (source of truth)
 * and overwrites any stale DB state.
 *
 * Flow:
 *  1. Resolve the asset's sidecar path.
 *  2. Read the sidecar (ENOENT → skip).
 *  3. Parse the metadata block via `parseXmpMetadata`.
 *  4. If no metadata fields found → skip.
 *  5. Build `metadata_override` patch.
 *  6. Recompute `captured_year`/`captured_month` from effective captured_at.
 *  7. If GPS changed relative to the existing override → re-arm `geocode` so it
 *     re-runs with the new coordinates.
 *  8. Return `{ patch, invalidates }`.
 *
 * The `POST /api/xmp/batch` route marks this stage dirty by setting
 * `stages.sidecar-metadata-index.version = 0` on affected assets, causing the claim
 * query to pick them up on the next poll.
 *
 * ## Why the downstream re-arms are declared rather than written
 *
 * Three stages can need re-arming from one run of this handler: `meili` always,
 * `geocode` when the coordinates moved, and `cf-thumb-sync` when the asset just
 * became visible again. The first was always declared as `invalidates`; the
 * other two were separate `updateOne` calls this handler issued itself, before
 * returning, and that is a write that can be lost independently of the patch it
 * belongs with — a crash in the gap leaves the new coordinates stored with
 * `geocode` still marked done against the old ones, and nothing notices. Named
 * in `invalidates` instead, all three are statements in the same transaction as
 * this stage's own success row (`db/sqlite/repos/stage-writeback.ts`), so either
 * everything lands or nothing does.
 *
 * Spec: docs/superpowers/specs/2026-06-26-batch-metadata-editor-design.md
 */

import * as fs from 'node:fs/promises';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';
import type { ImageDoc, StageContext, StageResult } from '../run-stage.ts';
import { xmpSidecarPath } from '../../fs/xmp.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { parseXmpMetadata, xmpMetadataToOverridePatch } from '../../xmp/metadata-parser.ts';
import { parseYearMonth } from '../../metadata/override-resolver.ts';
import type { MetadataOverride } from '../../db/schema.ts';
import { sidecarMetadataStatements } from '../../db/sqlite/repos/assets.stage-patches.ts';
import { assetAbsPath } from '../../indexer/images.repo.ts';
import { isLikelyScreenshot } from '../../indexer/screenshot.ts';
import { isVideoFilename } from '../../indexer/media-types.ts';
import { writeHiddenMarker, removeHiddenMarker } from '../../fs/hidden-marker.ts';
import { cleanupR2ThumbForHiddenAsset } from '../../cloudflare/hidden-cleanup.ts';

export const SIDECAR_METADATA_INDEX_VERSION = 1;

/** Name constant (used by batch route to find stage). */
export const SIDECAR_METADATA_INDEX_STAGE_NAME = 'sidecar-metadata-index' as const;

// ---------------------------------------------------------------------------
// GPS-change detection (for geocode re-trigger)
// ---------------------------------------------------------------------------

/** True when lat/lng changed enough to warrant a geocode re-run. */
function gpsChanged(
  oldGps: { lat: number; lng: number } | null | undefined,
  newGps: { lat: number; lng: number } | null | undefined,
): boolean {
  if (oldGps == null && newGps == null) return false;
  if (oldGps == null || newGps == null) return true;
  // Use a small epsilon — GPS coordinates stored at 4-decimal-minute precision.
  const EPS = 1e-7;
  return Math.abs(oldGps.lat - newGps.lat) > EPS || Math.abs(oldGps.lng - newGps.lng) > EPS;
}

// ---------------------------------------------------------------------------
// Stage handler
// ---------------------------------------------------------------------------

// fallow-ignore-next-line complexity
export async function sidecarMetadataIndexHandler(
  image: ImageDoc,
  ctx: StageContext,
): Promise<StageResult> {
  // 1. Resolve absolute path.
  const libraries = await loadLibraryRoots();
  const absPath = assetAbsPath(image, libraries, { allowMissing: true });
  if (!absPath) return { skip: 'no-path' };

  // 2. Read sidecar.
  const sidecarPath = xmpSidecarPath(absPath);
  let xml: string;
  try {
    xml = await fs.readFile(sidecarPath, 'utf-8');
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return { skip: 'no-sidecar' };
    }
    throw err;
  }

  // 3. Parse metadata block.
  const parsed = parseXmpMetadata(xml);

  // 4. Skip if no metadata fields found (sidecar exists but is adjustment-only).
  const parsedKeys = Object.keys(parsed);
  if (parsedKeys.length === 0) return { skip: 'no-metadata' };

  // 5. Build MetadataOverride patch.
  const overridePatch = xmpMetadataToOverridePatch(parsed);
  const touchedFields = Object.keys(overridePatch);
  if (touchedFields.length === 0) return { skip: 'no-metadata' };

  const override: MetadataOverride = {
    edited_at: new Date().toISOString(),
    touched_fields: touchedFields,
    ...overridePatch,
  };

  // 6. Recompute effective capture year/month and store them in the override
  //    (derived). NEVER write `exif.*` — it is the immutable file-original
  //    (spec invariant). effective = override ?? exif; migrating the search/sort
  //    indexes to read the effective year/month is tracked as a follow-up.
  const effectiveCapturedAt = override.captured_at ?? image.exif?.captured_at ?? null;
  const { year, month } = parseYearMonth(effectiveCapturedAt);
  if (year !== null) {
    override.captured_year = year;
    override.captured_month = month ?? undefined;
  } else {
    // No effective capture time → derived year/month must be absent, never
    // stale. (override is rebuilt fresh and the patch is a full $set of
    // metadata_override, so this is also robust if patch semantics ever change.)
    delete override.captured_year;
    delete override.captured_month;
  }

  const primaryFile = image.fileinfo?.find((e) => !e.deleted_at);
  const isVideo = !!primaryFile && isVideoFilename(primaryFile.filename);

  const nativeIsScreenshot = (() => {
    if (image.vision?.is_screenshot !== undefined && image.vision?.is_screenshot !== null) {
      return image.vision.is_screenshot;
    }
    if (!primaryFile) return false;
    return isLikelyScreenshot(primaryFile.filename, image.exif?.camera_make ?? null);
  })();

  const effectiveIsScreenshot =
    override.is_screenshot !== undefined && override.is_screenshot !== null
      ? override.is_screenshot
      : nativeIsScreenshot;

  // Hidden precedence: an explicit user override always wins. Absent an
  // override, the effective value is the prior hidden status.
  const priorHidden = image.hidden === true;
  const finalHidden = override.hidden ?? priorHidden;

  // Project the culling fields onto the asset row so search/sort, grid badges
  // and folder listings see them. The sidecar is the source of truth for
  // culling, so all five are written unconditionally: an absent attribute means
  // the user cleared it, and the stored value has to go back to the insert
  // default (rating 0, flag 0, empty label) rather than keep a stale one. The
  // override document and the row go in one transaction, so the projection can
  // never disagree with the document it was derived from.
  const patch = sidecarMetadataStatements(image._id.toHexString(), {
    metadataOverride: override,
    rating: override.rating ?? 0,
    flag: override.flag === 'pick' ? 1 : override.flag === 'reject' ? -1 : 0,
    colorLabel: override.color_label ?? '',
    // `is_screenshot` is a stills-only concept (#2325). An explicit override
    // stays in the sidecar untouched — XMP is the contract and it is the user's
    // data — but the projected column that search, the facet counts and the
    // Photos/Screenshots filter read is clamped, so the invariant holds
    // everywhere it is observable without discarding anything the user wrote.
    isScreenshot: isVideo ? false : effectiveIsScreenshot,
    hidden: finalHidden,
    // Three cases, not two: said to hide, said to un-hide, said nothing. The
    // last leaves whatever reason is stored alone — see `SidecarMetadataPatch`.
    hiddenReason:
      override.hidden === true ? 'manual' : override.hidden === false ? null : undefined,
  });

  if (finalHidden) {
    await writeHiddenMarker(absPath);
  } else {
    await removeHiddenMarker(absPath);
  }

  // Newly hidden by this projection (a manual toggle via the Batch
  // Metadata Editor, most commonly) — any thumbnail already mirrored to R2
  // must come down; see cloudflare/hidden-cleanup.ts. Best-effort/non-throwing.
  if (finalHidden && !priorHidden) {
    await cleanupR2ThumbForHiddenAsset(image);
  }

  // Effective hidden/screenshot/place metadata changes affect Meilisearch
  // filters or semantic document text, so the search document is rebuilt
  // atomically with the metadata projection.
  const invalidates = ['meili'];

  // The inverse transition — explicitly un-hidden — re-arms `cf-thumb-sync` so
  // the pipeline picks the asset back up: that stage's own `{ skip: 'hidden' }`
  // marks it permanently done for a hidden asset (a stage's version is the
  // "already handled" signal, including for terminal skips), so without this an
  // un-hidden asset would never get its thumbnail mirrored to R2 again. The
  // re-arm is the full five-field reset, so a previously dead-lettered or
  // errored run stops showing its stale error on Settings → Workers.
  if (priorHidden && !finalHidden) invalidates.push('cf-thumb-sync');

  // 7. If GPS changed, re-arm geocode so it re-runs against the new coordinates.
  const oldGps = image.metadata_override?.gps
    ? {
        lat: image.metadata_override.gps.lat,
        lng: image.metadata_override.gps.lng,
      }
    : null;
  const newGps = override.gps ? { lat: override.gps.lat, lng: override.gps.lng } : null;

  if (gpsChanged(oldGps, newGps) && newGps !== null) {
    invalidates.push('geocode');
    ctx.log.info(
      { id: image._id.toHexString() },
      'sidecar-metadata-index: GPS changed, re-arming geocode stage',
    );
  }

  return { patch, invalidates };
}

// ---------------------------------------------------------------------------
// Stage registration
// ---------------------------------------------------------------------------

const sidecarMetadataIndexStage = defineStage({
  name: SIDECAR_METADATA_INDEX_STAGE_NAME,
  targetVersion: SIDECAR_METADATA_INDEX_VERSION,
  dependsOn: ['exif'],
  defaults: {
    concurrency: 4,
    maxAttempts: 3,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: false,
  },
  handler: sidecarMetadataIndexHandler,
});

export default sidecarMetadataIndexStage;

export async function startSidecarMetadataIndexStage(): Promise<RunStageHandle> {
  return runStage(sidecarMetadataIndexStage);
}
