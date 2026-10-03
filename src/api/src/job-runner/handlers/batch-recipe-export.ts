/** A recipe job reuses JobRunner's lease/cancel/checkpoint contract. One render at a time. */
import { exportOriginals, type ExportOriginals } from '../../export/export-originals.ts';
import { parseExportPayload, type ExportTarget } from '../../export/export-payload.ts';
import {
  prepareExport,
  publishExport,
  exportFailure,
  type ExportEntry,
} from '../../export/export-files.ts';
import type { ExportRecipe } from '../../generated/export-recipe.generated.ts';
import type { JobHandler } from './index.ts';

class ExportCheckpointError extends Error {}
const TERMINAL = new Set(['applied', 'failed', 'skipped']);
const done = (entry: ExportEntry | null): boolean => !!entry && TERMINAL.has(entry.status);

function readLedger(stored: unknown, targets: ExportTarget[]): (ExportEntry | null)[] {
  if (stored === undefined) return targets.map(() => null);
  if (!Array.isArray(stored) || stored.length !== targets.length)
    throw new Error('Export ledger does not match the selected photos');
  for (const [index, entry] of stored.entries()) {
    if (
      entry &&
      (entry.id !== targets[index].id ||
        !['rendering', 'prepared', 'applied', 'failed', 'skipped'].includes(entry.status))
    )
      throw new Error('Export ledger identity mismatch');
  }
  return stored;
}

function summary(entries: (ExportEntry | null)[], targets: ExportTarget[]) {
  const value = {
    applied: [] as string[],
    skipped: [] as string[],
    remaining: [] as string[],
    failed: [] as { id: string; reason: string }[],
    outputs: [] as { id: string; path: string | undefined }[],
  };
  for (const [index, entry] of entries.entries()) {
    if (!done(entry)) value.remaining.push(targets[index].id);
    if (!entry) continue;
    if (entry.status === 'applied') {
      value.applied.push(entry.id);
      value.outputs.push({ id: entry.id, path: entry.outputPath });
    }
    if (entry.status === 'skipped') value.skipped.push(entry.id);
    if (entry.status === 'failed')
      value.failed.push({
        id: entry.id,
        reason: entry.reason ?? 'Export failed',
      });
  }
  return value;
}

async function prepareItem(
  target: ExportTarget,
  recipe: ExportRecipe,
  jobId: string,
  previous: ExportEntry | null,
  originals: ExportOriginals,
  save: (entry: ExportEntry) => Promise<void>,
): Promise<ExportEntry> {
  try {
    return await prepareExport(target, recipe, jobId, previous, originals, async (entry) => {
      try {
        await save(entry);
      } catch (error) {
        throw new ExportCheckpointError(String(error));
      }
    });
  } catch (error) {
    // Rendering failures are item-local. A lost durable checkpoint stops all publication.
    if (error instanceof ExportCheckpointError) throw error;
    return { id: target.id, status: 'failed', reason: exportFailure(error) };
  }
}

async function publishItem(
  entry: ExportEntry,
  recipe: ExportRecipe,
  jobId: string,
  originals: ExportOriginals,
): Promise<ExportEntry> {
  if (entry.status !== 'prepared') return entry;
  try {
    return await publishExport(entry, recipe, jobId, originals);
  } catch (error) {
    return { ...entry, status: 'failed', reason: exportFailure(error) };
  }
}

export const batchRecipeExportHandler: JobHandler = {
  async run(raw, ctx) {
    const payload = parseExportPayload(raw);
    const { targets, recipe } = payload;
    const checkpoint = ctx.saveCheckpoint;
    if (!checkpoint) throw new Error('Recipe export requires a durable job ledger');
    const entries = readLedger(ctx.checkpoint?.['entries'], targets);
    const originals = await exportOriginals(payload, ctx.checkpoint);
    const result = () => summary(entries, targets);
    const save = () =>
      checkpoint({
        ...(ctx.checkpoint?.['originalPaths'] === undefined
          ? {}
          : { originalPaths: ctx.checkpoint['originalPaths'] }),
        entries,
        ...result(),
      });
    await save();
    await ctx.reportProgress(entries.filter(done).length, targets.length);
    for (const [index, target] of targets.entries()) {
      if (await ctx.shouldCancel())
        return { kind: 'cancelled', result: { ...result(), cancelled: true } };
      if (done(entries[index])) continue;
      entries[index] = await prepareItem(
        target,
        recipe,
        ctx.jobId.toHexString(),
        entries[index],
        originals,
        async (entry) => {
          entries[index] = entry;
          await save();
        },
      );
      // Fenced checkpoint precedes filesystem publication, including after a long native render.
      await save();
      if (await ctx.shouldCancel())
        return { kind: 'cancelled', result: { ...result(), cancelled: true } };
      entries[index] = await publishItem(
        entries[index]!,
        recipe,
        ctx.jobId.toHexString(),
        originals,
      );
      await save();
      await ctx.reportProgress(entries.filter(done).length, targets.length);
    }
    return { kind: 'done', result: { ...result(), cancelled: false } };
  },
};
