/**
 * POST /api/xmp/batch — bulk sidecar write + sidecar-metadata-index dirty-mark.
 *
 * Accepts N `{ address, metadata }` entries where address is a slug:relPath
 * string. For each:
 *   1. Resolves the address to an absolute path inside the library jail.
 *   2. Reads existing sidecar (creates a stub when none exists).
 *   3. Merges the metadata fields into the sidecar via `mergeMetadataIntoXmp`.
 *   4. Writes the merged sidecar atomically (temp-file + rename).
 *   5. Marks the asset's `sidecar-metadata-index` stage dirty in MongoDB so the
 *      polled stage reconciles `metadata_override` on the next tick.
 *
 * Partial failures are reported per-asset; successes are not rolled back.
 *
 * Spec: docs/superpowers/specs/2026-06-26-batch-metadata-editor-design.md
 * §"Where the ingest happens"
 */

import { Elysia, t } from 'elysia';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveAddressString } from '../library/address.ts';
import { xmpSidecarPath, writeXmpAtomic } from '../fs/xmp.ts';
import { mergeMetadataIntoXmp } from '../xmp/metadata-serializer.ts';
import { isVideoFilename } from '../indexer/media-types.ts';
import type { XmpMetadataInput } from '../xmp/metadata-input.ts';
import { coll } from '../indexer/images.repo.ts';
import { SIDECAR_METADATA_INDEX_STAGE_NAME } from '../workers/stages/sidecar-metadata-index.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('routes/xmp-batch');

// ---------------------------------------------------------------------------
// Per-asset processing
// ---------------------------------------------------------------------------

interface BatchEntry {
  address: string;
  metadata: XmpMetadataInput;
}

interface EntryResult {
  address: string;
  ok: boolean;
  error?: string;
  /** Resolved absolute path, set on success — collected for one batched dirty-mark. */
  absPath?: string;
}

async function processEntry(entry: BatchEntry): Promise<EntryResult> {
  let absPath: string;
  try {
    const resolved = await resolveAddressString(entry.address);
    absPath = resolved.absPath;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { address: entry.address, ok: false, error: msg };
  }
  const sidecarPath = xmpSidecarPath(absPath);

  // Read existing sidecar (or start with empty string → stub created by mergeMetadataIntoXmp).
  let existingXml = '';
  try {
    existingXml = await fs.readFile(sidecarPath, 'utf-8');
  } catch (err: unknown) {
    if (
      !err ||
      typeof err !== 'object' ||
      !('code' in err) ||
      (err as NodeJS.ErrnoException).code !== 'ENOENT'
    ) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        address: entry.address,
        ok: false,
        error: `XMP read failed: ${msg}`,
      };
    }
    // ENOENT is expected — start from empty (serializer will create stub).
  }

  // Merge metadata into sidecar. For video assets with no existing sidecar,
  // use a metadata-only stub (no Camera Raw Settings attrs) so the sidecar
  // is not misinterpreted as containing pixel adjustments.
  const metadataOnly = existingXml.length === 0 && isVideoFilename(path.basename(absPath));
  const merged = mergeMetadataIntoXmp(existingXml, entry.metadata, {
    metadataOnly,
  });

  // Write atomically.
  const writeResult = await writeXmpAtomic(absPath, merged);
  if (!writeResult.ok) {
    return { address: entry.address, ok: false, error: writeResult.error };
  }

  // The sidecar-metadata-index dirty-mark is batched into a single updateMany after
  // the whole request completes (see the route handler) — never per-entry.
  return { address: entry.address, ok: true, absPath };
}

/**
 * Mark the sidecar-metadata-index stage dirty (version 0) for every successfully
 * written asset, in a SINGLE `updateMany` (one collection handle, one query) —
 * never per-entry. The claim query picks the assets up on the next poll.
 *
 * Assets store their location as a (library_root, relDir, filename) triple, so
 * we match on `filename` (via `$in`) as a cheap filter; a duplicate filename
 * across libraries marks both dirty — harmless (the stage is idempotent).
 */
async function markSidecarMetadataIndexDirtyBatch(absPaths: string[]): Promise<void> {
  const filenames = [...new Set(absPaths.map((p) => path.basename(p)).filter(Boolean))];
  if (filenames.length === 0) return;

  const images = await coll();
  const stagePath = `stages.${SIDECAR_METADATA_INDEX_STAGE_NAME}`;
  await images.updateMany(
    { 'fileinfo.filename': { $in: filenames } },
    {
      $set: {
        [`${stagePath}.version`]: 0,
        [`${stagePath}.dead`]: false,
        [`${stagePath}.attempts`]: 0,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/** Elysia type validator for the metadata body (open schema — unknown keys allowed). */
const MetadataInputSchema = t.Object(
  {
    gpsLatitude: t.Optional(t.Nullable(t.Number())),
    gpsLongitude: t.Optional(t.Nullable(t.Number())),
    gpsAltitude: t.Optional(t.Nullable(t.Number())),
    dateTimeOriginal: t.Optional(t.Nullable(t.String())),
    timeZone: t.Optional(t.Nullable(t.String())),
    sublocation: t.Optional(t.Nullable(t.String())),
    city: t.Optional(t.Nullable(t.String())),
    state: t.Optional(t.Nullable(t.String())),
    country: t.Optional(t.Nullable(t.String())),
    countryCode: t.Optional(t.Nullable(t.String())),
    title: t.Optional(t.Nullable(t.String())),
    caption: t.Optional(t.Nullable(t.String())),
    headline: t.Optional(t.Nullable(t.String())),
    instructions: t.Optional(t.Nullable(t.String())),
    creator: t.Optional(t.Nullable(t.String())),
    creatorJobTitle: t.Optional(t.Nullable(t.String())),
    copyrightNotice: t.Optional(t.Nullable(t.String())),
    copyrightStatus: t.Optional(
      t.Nullable(
        t.Union([t.Literal('unknown'), t.Literal('copyrighted'), t.Literal('public-domain')]),
      ),
    ),
    usageTerms: t.Optional(t.Nullable(t.String())),
    credit: t.Optional(t.Nullable(t.String())),
    source: t.Optional(t.Nullable(t.String())),
    keywords: t.Optional(t.Array(t.String())),
    rating: t.Optional(t.Nullable(t.Integer({ minimum: 0, maximum: 5 }))),
    flag: t.Optional(
      t.Nullable(t.Union([t.Literal('pick'), t.Literal('reject'), t.Literal('unflagged')])),
    ),
    colorLabel: t.Optional(
      t.Nullable(
        t.Union([
          t.Literal('red'),
          t.Literal('orange'),
          t.Literal('yellow'),
          t.Literal('green'),
          t.Literal('blue'),
        ]),
      ),
    ),
    isScreenshot: t.Optional(t.Nullable(t.Boolean())),
  },
  { additionalProperties: true },
);

const BatchEntrySchema = t.Object({
  address: t.String(),
  metadata: MetadataInputSchema,
});

const BatchBodySchema = t.Object({
  entries: t.Array(BatchEntrySchema),
});

export const xmpBatchRoutes = new Elysia().post(
  '/api/xmp/batch',
  async ({ body, set }) => {
    const entries = body.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      set.status = 400;
      return { error: 'entries must be a non-empty array' };
    }
    if (entries.length > 1000) {
      set.status = 400;
      return { error: 'entries exceeds maximum batch size of 1000' };
    }

    // Process entries concurrently (capped to avoid overwhelming fs).
    const CONCURRENCY = 20;
    const results: EntryResult[] = [];
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const batch = entries.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map((e) => processEntry(e as BatchEntry)));
      results.push(...batchResults);
    }

    // Mark sidecar-metadata-index dirty for all successful writes in ONE updateMany
    // (best-effort: a reconcile-trigger failure doesn't invalidate the writes).
    const okPaths = results.filter((r) => r.ok && r.absPath).map((r) => r.absPath as string);
    if (okPaths.length > 0) {
      try {
        await markSidecarMetadataIndexDirtyBatch(okPaths);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          { count: okPaths.length, err: msg },
          'xmp-batch: failed to mark sidecar-metadata-index dirty',
        );
      }
    }

    const hasErrors = results.some((r) => !r.ok);
    set.status = hasErrors ? 207 : 200;
    // Strip the internal absPath from the response.
    return {
      results: results.map((r) => ({
        address: r.address,
        ok: r.ok,
        ...(r.error ? { error: r.error } : {}),
      })),
    };
  },
  {
    body: BatchBodySchema,
    detail: {
      summary: 'Bulk-write XMP metadata sidecars',
      description:
        'Write metadata fields to N asset sidecars in one request. Each entry is processed atomically (temp-file + rename). Partial failures are reported per-asset. Successful writes trigger the `sidecar-metadata-index` stage for each asset.',
      tags: ['xmp'],
    },
  },
);
