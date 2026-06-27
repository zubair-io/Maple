/**
 * `override-ingest` stage (#1580 — Batch Metadata M1).
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
 *  7. If GPS changed relative to the existing override → reset `geocode` stage
 *     so it re-runs with the new coordinates.
 *  8. Return `{ patch }`.
 *
 * The `POST /api/xmp/batch` route marks this stage dirty by setting
 * `stages.override-ingest.version = 0` on affected assets, causing the claim
 * query to pick them up on the next poll.
 *
 * Spec: docs/superpowers/specs/2026-06-26-batch-metadata-editor-design.md
 */

import * as fs from 'node:fs/promises';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';
import type { ImageDoc, StageContext, StageResult } from '../run-stage.ts';
import { xmpSidecarPath } from '../../fs/xmp.ts';
import { assetAbsPath } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { parseXmpMetadata, xmpMetadataToOverridePatch } from '../../xmp/metadata-parser.ts';
import { parseYearMonth } from '../../metadata/override-resolver.ts';
import type { MetadataOverride } from '../../db/schema.ts';
import { coll } from '../../indexer/images.repo.ts';

export const OVERRIDE_INGEST_VERSION = 1;

/** Name constant (used by batch route to find stage). */
export const OVERRIDE_INGEST_STAGE_NAME = 'override-ingest' as const;

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

export async function overrideIngestHandler(
  image: ImageDoc,
  ctx: StageContext,
): Promise<StageResult> {
  // 1. Resolve absolute path.
  const libraries = await loadLibraryRoots();
  const absPath = assetAbsPath(image, libraries);
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

  // 6. Recompute captured_year/month from effective captured_at.
  const effectiveCapturedAt = override.captured_at ?? image.exif?.captured_at ?? null;
  const { year, month } = parseYearMonth(effectiveCapturedAt);

  const patch: Record<string, unknown> = {
    metadata_override: override,
  };
  // Only write year/month when we have an effective captured_at.
  if (year !== null) {
    patch['exif.captured_year'] = year;
    patch['exif.captured_month'] = month;
  }

  // 7. If GPS changed, reset geocode stage to trigger re-run.
  const oldGps = image.metadata_override?.gps
    ? { lat: image.metadata_override.gps.lat, lng: image.metadata_override.gps.lng }
    : null;
  const newGps = override.gps ? { lat: override.gps.lat, lng: override.gps.lng } : null;

  if (gpsChanged(oldGps, newGps) && newGps !== null) {
    // Reset geocode stage version to 0 so the claim query picks it up.
    // We cannot set stages.* in the returned patch (forbidden by run-stage.ts),
    // so we issue a separate targeted update before returning.
    const images = await coll();
    await images.updateOne(
      { _id: image._id },
      {
        $set: {
          'stages.geocode.version': 0,
          'stages.geocode.dead': false,
          'stages.geocode.attempts': 0,
        },
      },
    );
    ctx.log.info(
      { id: image._id.toHexString() },
      'override-ingest: GPS changed, reset geocode stage',
    );
  }

  return { patch };
}

// ---------------------------------------------------------------------------
// Stage registration
// ---------------------------------------------------------------------------

const overrideIngestStage = defineStage({
  name: OVERRIDE_INGEST_STAGE_NAME,
  targetVersion: OVERRIDE_INGEST_VERSION,
  dependsOn: ['exif'],
  defaults: {
    concurrency: 4,
    maxAttempts: 3,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: false,
  },
  handler: overrideIngestHandler,
});

export default overrideIngestStage;

export async function startOverrideIngestStage(): Promise<RunStageHandle> {
  return runStage(overrideIngestStage);
}
