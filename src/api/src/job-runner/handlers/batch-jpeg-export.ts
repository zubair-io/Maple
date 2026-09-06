/** Backward-compatible JPEG jobs use the same developed-image recipe pipeline (#2438). */
import { ObjectId } from 'mongodb';
import { readFile } from '../../fs/mirrored.ts';
import { xmpSidecarPath } from '../../fs/xmp.ts';
import { assetsCollection } from '../../db/client.ts';
import { assetAbsPath } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { DEFAULT_EXPORT_RECIPE } from '../../generated/export-recipe.generated.ts';
import { parseExportPayload } from '../../export/export-payload.ts';
import { batchRecipeExportHandler } from './batch-recipe-export.ts';
import type { JobHandler } from './index.ts';

function assetIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2000)
    throw new Error('batch_jpeg_export requires 1–2,000 valid asset IDs');
  if (value.some((id) => typeof id !== 'string' || !ObjectId.isValid(id)))
    throw new Error('batch_jpeg_export contains an invalid asset ID');
  return value;
}
async function snapshot(path: string): Promise<string> {
  try {
    return await readFile(xmpSidecarPath(path), 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  }
}

async function recipePayload(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ids = assetIds(raw['assetIds']);
  const roots = await loadLibraryRoots();
  const docs = await (await assetsCollection())
    .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } })
    .toArray();
  const byId = new Map(docs.map((doc) => [doc._id.toHexString(), doc]));
  const targets = [];
  for (const [index, id] of ids.entries()) {
    const doc = byId.get(id);
    const path = doc ? assetAbsPath(doc, roots) : null;
    if (!path) throw new Error(`Cannot resolve original ${id}`);
    const xmp = await snapshot(path);
    targets.push({ id, path, xmp, index, capturedAt: doc?.exif?.captured_at ?? null });
  }
  const payload = {
    targets,
    recipe: {
      ...DEFAULT_EXPORT_RECIPE,
      quality: raw['quality'] ?? 82,
      maxLongEdge: raw['maxPx'] ?? 4096,
      destination: 'directory',
      directory: raw['outputDir'],
      overwritePolicy: 'error',
    },
  };
  parseExportPayload(payload);
  return payload;
}

export const batchJpegExportHandler: JobHandler = {
  async run(raw, ctx) {
    if (!ctx.saveCheckpoint) throw new Error('Export requires a durable ledger');
    const saved = ctx.checkpoint?.['exportPayload'];
    const payload =
      saved && typeof saved === 'object'
        ? (saved as Record<string, unknown>)
        : await recipePayload(raw);
    // Persist the original XMP snapshot so recovery cannot pick up later edits.
    await ctx.saveCheckpoint({ ...ctx.checkpoint, exportPayload: payload });
    return batchRecipeExportHandler.run(payload, {
      ...ctx,
      saveCheckpoint: (value) => ctx.saveCheckpoint!({ ...value, exportPayload: payload }),
    });
  },
};
