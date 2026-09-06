/** Durable per-target ledger. A reclaimed job reconciles writes before acknowledgement. */
import type { JobHandler } from './index.ts';
import { parseSyncPayload } from './batch-sync-payload.ts';
import { restoredEntries, syncSummary, type SyncEntry } from './batch-sync-ledger.ts';
import { prepareTarget, commitTarget, type PreparedTarget } from './batch-sync-target.ts';
import { publishBatchSidecarEdit } from './batch-sync-notification.ts';

// Public payload parser remains the route's validation entry point.
export { parseSyncPayload } from './batch-sync-payload.ts';

async function finishTarget(prepared: PreparedTarget): Promise<SyncEntry> {
  if (prepared.action === 'none') return prepared.entry;
  if (prepared.action === 'write') {
    const result = await commitTarget(prepared);
    if (!result.ok)
      return { ...prepared.entry, status: 'failed', reason: result.error ?? 'XMP write failed' };
  }
  // Database/notification failures leave the prepared checkpoint intact. Recovery
  // republishes after matching the after-hash, without touching the sidecar again.
  await publishBatchSidecarEdit(prepared.entry.id, prepared.path);
  return { ...prepared.entry, status: 'applied' };
}

export const batchAdjustmentSyncHandler: JobHandler = {
  async run(raw, ctx) {
    const payload = parseSyncPayload(raw);
    if (!ctx.saveCheckpoint) throw new Error('Batch sync requires a durable job ledger');
    const entries = restoredEntries(ctx.checkpoint, payload.targets);
    const save = async (entryIndex?: number): Promise<void> =>
      ctx.saveCheckpoint!({ entries, ...syncSummary(payload.targets, entries) }, entryIndex);
    const result = (cancelled: boolean) => ({
      kind: cancelled ? ('cancelled' as const) : ('done' as const),
      result: { ...syncSummary(payload.targets, entries), cancelled },
    });
    await save();
    await ctx.reportProgress(
      entries.filter((entry) => entry?.status === 'applied' || entry?.status === 'failed').length,
      payload.targets.length,
    );
    for (const [index, target] of payload.targets.entries()) {
      if (await ctx.shouldCancel()) return result(true);
      if (entries[index]?.status === 'applied' || entries[index]?.status === 'failed') continue;
      const prepared = await prepareTarget(
        target,
        payload.patch,
        entries[index],
        payload.relativeWhiteBalance,
      );
      entries[index] = prepared.entry;
      await save(index); // Persists the frozen patch and fences ownership before writing.
      if (await ctx.shouldCancel()) return result(true);
      entries[index] = await finishTarget(prepared);
      await save(index);
      await ctx.reportProgress(index + 1, payload.targets.length);
    }
    return result(false);
  },
};
