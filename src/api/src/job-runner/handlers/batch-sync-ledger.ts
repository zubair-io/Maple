import type {
  BatchAssetStatus,
  BatchTransferSummary,
} from '../../generated/batch-transfer.generated.ts';
import { parseTransferPatch, type XmpTransferPatch } from '../../xmp/transfer-patch.ts';
import type { SyncTarget } from './batch-sync-payload.ts';

export interface SyncEntry {
  id: string;
  status: Exclude<BatchAssetStatus, 'pending'>;
  patch?: XmpTransferPatch;
  beforeHash?: string;
  afterHash?: string;
  reason?: string;
}

export function syncSummary(
  targets: readonly SyncTarget[],
  entries: readonly (SyncEntry | null)[],
): Omit<BatchTransferSummary, 'cancelled'> & { remaining: string[] } {
  return {
    applied: entries.filter((entry) => entry?.status === 'applied').map((entry) => entry!.id),
    failed: entries
      .filter((entry) => entry?.status === 'failed')
      .map((entry) => ({
        id: entry!.id,
        reason: entry!.reason ?? 'Write failed',
      })),
    remaining: targets
      .filter((_, index) => !entries[index] || entries[index]?.status === 'prepared')
      .map((target) => target.id),
  };
}

export function restoredEntries(
  raw: Record<string, unknown> | undefined,
  targets: readonly SyncTarget[],
): (SyncEntry | null)[] {
  const entries = raw?.['entries'];
  if (entries === undefined) return targets.map(() => null);
  if (!Array.isArray(entries) || entries.length !== targets.length)
    throw new Error('Invalid saved batch ledger');
  return entries.map((entry, index) => {
    if (entry === null) return null;
    if (
      !entry ||
      entry.id !== targets[index].id ||
      !['prepared', 'applied', 'failed'].includes(entry.status)
    ) {
      throw new Error('Saved batch ledger does not match its photos');
    }
    if (entry.patch !== undefined) parseTransferPatch(entry.patch);
    if (
      entry.status === 'prepared' &&
      (![entry.beforeHash, entry.afterHash].every(
        (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
      ) ||
        !entry.patch)
    )
      throw new Error('Invalid prepared batch ledger');
    return entry as SyncEntry;
  });
}
