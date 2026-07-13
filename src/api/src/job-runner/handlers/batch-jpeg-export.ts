/**
 * `batch_jpeg_export` job handler.
 *
 * Payload:
 *   {
 *     assetIds: string[],   // ObjectId hex strings — assets to export
 *     outputDir: string,    // absolute filesystem directory
 *     quality: number,      // JPEG quality 1..100 (clamped)
 *   }
 *
 * For each asset id: load the doc, hand the absolute RAW path to the
 * existing FFI thumbnailer to render a JPEG into `outputDir/<filename>.jpg`,
 * bump progress. Cancellation is checked between assets so the user can
 * abort an in-flight export.
 *
 * Reuses `ffiPool().renderThumbnailPreviewJpegToFile` deliberately (shared
 * with the 1280px VLM describe/OCR preview tier, #1978) — it's the only
 * RAW→JPEG path we have and it already serialises calls into the dylib so
 * the export doesn't starve the indexer's thumb stage. See
 * `docs/workers-architecture.md` §11 ("Reuse the FFI pool").
 */

import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ObjectId } from 'mongodb';
import { assetsCollection } from '../../db/client.ts';
import { ffiPool } from '../../ffi/ffi-pool.ts';
import { assetAbsPath } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import type { JobHandler, JobHandlerContext, JobHandlerResult } from './index.ts';

const DEFAULT_MAX_PX = 4096; // long-edge cap; matches the largest preview tier
const MIN_QUALITY = 1;
const MAX_QUALITY = 100;
const DEFAULT_QUALITY = 82;

interface BatchJpegExportPayload {
  assetIds: string[];
  outputDir: string;
  quality?: number;
  maxPx?: number;
}

interface BatchJpegExportResult {
  successCount: number;
  failedCount: number;
  outputPaths: string[];
  failures: Array<{ assetId: string; error: string }>;
}

function parsePayload(raw: Record<string, unknown>): BatchJpegExportPayload {
  const ids = raw.assetIds;
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
    throw new Error('batch_jpeg_export: payload.assetIds must be string[]');
  }
  const outputDir = raw.outputDir;
  if (typeof outputDir !== 'string' || outputDir.length === 0) {
    throw new Error('batch_jpeg_export: payload.outputDir must be a non-empty string');
  }
  const qRaw = typeof raw.quality === 'number' ? raw.quality : DEFAULT_QUALITY;
  const quality = Math.max(MIN_QUALITY, Math.min(MAX_QUALITY, Math.floor(qRaw)));
  const maxPxRaw = typeof raw.maxPx === 'number' ? raw.maxPx : DEFAULT_MAX_PX;
  const maxPx = Math.max(64, Math.floor(maxPxRaw));
  return { assetIds: ids as string[], outputDir, quality, maxPx };
}

/** Replace the source extension with `.jpg`; falls back to `<stem>.jpg`. */
function jpgFilename(absPath: string): string {
  const base = basename(absPath);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem}.jpg`;
}

export const batchJpegExportHandler: JobHandler = {
  async run(
    rawPayload: Record<string, unknown>,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const { assetIds, outputDir, quality, maxPx } = parsePayload(rawPayload);
    await mkdir(outputDir, { recursive: true });

    const total = assetIds.length;
    await ctx.reportProgress(0, total);

    const result: BatchJpegExportResult = {
      successCount: 0,
      failedCount: 0,
      outputPaths: [],
      failures: [],
    };

    const coll = await assetsCollection();
    const pool = ffiPool();
    const libs = await loadLibraryRoots();

    // Bulk-resolve assets to avoid N+1 queries.
    const objectIds: ObjectId[] = [];
    for (const id of assetIds) {
      if (ObjectId.isValid(id)) {
        objectIds.push(new ObjectId(id));
      }
    }
    const docs = await coll.find({ _id: { $in: objectIds } }).toArray();
    const docsById = new Map(docs.map((d) => [d._id.toHexString(), d]));

    for (let i = 0; i < assetIds.length; i++) {
      // Cancellation gate — runs before each asset so a request mid-batch
      // takes effect without abandoning a render mid-flight.
      if (await ctx.shouldCancel()) {
        return { kind: 'cancelled', result: result as unknown as Record<string, unknown> };
      }

      const idHex = assetIds[i];
      try {
        if (!ObjectId.isValid(idHex)) {
          throw new Error(`invalid ObjectId: ${idHex}`);
        }
        const doc = docsById.get(new ObjectId(idHex).toHexString());
        if (!doc) throw new Error(`asset not found: ${idHex}`);
        const srcPath = assetAbsPath(doc, libs);
        if (!srcPath) {
          throw new Error(`asset has no resolvable location: ${idHex}`);
        }
        const outPath = join(outputDir, jpgFilename(srcPath));
        const ok = await pool.renderThumbnailPreviewJpegToFile(
          srcPath,
          outPath,
          maxPx ?? DEFAULT_MAX_PX,
          quality ?? DEFAULT_QUALITY,
        );
        if (ok) {
          result.successCount += 1;
          result.outputPaths.push(outPath);
        } else {
          result.failedCount += 1;
          result.failures.push({ assetId: idHex, error: 'render returned false' });
        }
      } catch (err) {
        result.failedCount += 1;
        result.failures.push({
          assetId: idHex,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      await ctx.reportProgress(i + 1, total);
    }

    return { kind: 'done', result: result as unknown as Record<string, unknown> };
  },
};
