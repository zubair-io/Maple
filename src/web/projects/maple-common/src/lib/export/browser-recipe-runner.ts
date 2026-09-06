/** One browser render at a time; IndexedDB failures stop before any unrecorded delivery. */
import type { ExportRecipe } from '../generated/export-recipe.generated';
import type { ExportedFile } from '../raw-pipeline/raw-pipeline.types';
import type { RecipeEntry, RecipeQueueRecord, RecipeTarget } from './export-recipe-store';
import {
  prepareDirectoryEntry,
  deliverDirectoryEntry,
  recoverDirectoryWrites,
} from './recipe-directory-delivery';
import { downloadBlob } from './download-blob';

interface BrowserExportContext {
  filename: (target: RecipeTarget, recipe: ExportRecipe) => Promise<string>;
  render: (target: RecipeTarget, recipe: ExportRecipe) => Promise<ExportedFile>;
  save: (record: RecipeQueueRecord) => Promise<void>;
  cancelled: () => boolean;
  progress: (id: string) => void;
}
class QueuePersistenceError extends Error {}

async function renderEntry(
  record: RecipeQueueRecord,
  target: RecipeTarget,
  ctx: BrowserExportContext,
  saveEntry: (entry: RecipeEntry) => Promise<void>,
): Promise<RecipeEntry> {
  try {
    const filename = await ctx.filename(target, record.recipe);
    const entry = record.directoryHandle
      ? await prepareDirectoryEntry(record, target.id, filename)
      : { id: target.id, filename, status: 'rendering' as const };
    if (entry.status === 'skipped') return entry;
    const file = await ctx.render(target, record.recipe);
    if (record.directoryHandle)
      return await deliverDirectoryEntry(record, entry, file.blob, saveEntry);
    // Download acknowledgement is unknowable. Reload never automatically replays this marker.
    await saveEntry({ ...entry, status: 'delivering' });
    downloadBlob(file.blob, filename);
    return { ...entry, status: 'applied' };
  } catch (error) {
    if (error instanceof QueuePersistenceError) throw error;
    return {
      id: target.id,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runBrowserRecipe(
  record: RecipeQueueRecord,
  ctx: BrowserExportContext,
): Promise<void> {
  if (record.recipe.destination === 'directory' && !record.directoryHandle)
    throw new Error(
      'The saved destination folder is unavailable. Choose it again before exporting.',
    );
  await recoverDirectoryWrites(record);
  await ctx.save(record);
  for (const [index, target] of record.targets.entries()) {
    if (ctx.cancelled()) {
      await ctx.save({ ...record, cancelled: true });
      return;
    }
    if (record.entries[index].status !== 'pending') continue;
    const saveEntry = async (entry: RecipeEntry) => {
      record.entries[index] = entry;
      try {
        await ctx.save(record);
      } catch (error) {
        throw new QueuePersistenceError(String(error));
      }
    };
    await saveEntry({ id: target.id, status: 'rendering' });
    record.entries[index] = await renderEntry(record, target, ctx, saveEntry);
    await ctx.save(record);
    ctx.progress(target.id);
  }
}
