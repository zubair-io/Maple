/** Persisted per-target ledger. A reclaimed job continues pending work and never
 * replays completed edits; a write interrupted before acknowledgement is reconciled
 * by its before/after hashes, so an intervening edit becomes a reported conflict. */
import { createHash } from 'node:crypto';
import { stat } from '../../fs/mirrored.ts';
import { extname, isAbsolute, resolve } from 'node:path';
import type { JobHandler } from './index.ts';
import { xmpSidecarPath, writeXmpAtomic } from '../../fs/xmp.ts';
import { safeReadFile, safeWriteAllowed } from '../../fs/root.ts';
import { resolveAndAuthorizePath } from '../../routes/xmp-path-auth.ts';
import { isVideoFilename } from '../../indexer/media-types.ts';
import {
  applyTransferPatch,
  parseTransferPatch,
  type XmpTransferPatch,
} from '../../xmp/transfer-patch.ts';

export interface SyncTarget {
  id: string;
  path: string;
}
export interface SyncPayload {
  targets: SyncTarget[];
  patch: XmpTransferPatch;
}
export interface SyncEntry {
  id: string;
  status: 'prepared' | 'applied' | 'failed';
  beforeHash?: string;
  afterHash?: string;
  reason?: string;
}

export function parseSyncPayload(raw: Record<string, unknown>): SyncPayload {
  const values = raw['targets'];
  if (!Array.isArray(values) || values.length < 1 || values.length > 2000)
    throw new Error('Choose 1–2,000 photos');
  const targets = values.map((value): SyncTarget => {
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.id !== 'string' ||
      !value.id.length ||
      value.id.length > 2048 ||
      typeof value.path !== 'string' ||
      value.path.length > 8192 ||
      !isAbsolute(value.path) ||
      value.path.includes('\0')
    ) {
      throw new Error('Every photo needs an id and an absolute path');
    }
    if (isVideoFilename(value.path) || extname(value.path).toLowerCase() === '.xmp')
      throw new Error('Sync settings requires photos');
    return { id: value.id, path: value.path };
  });
  if (
    new Set(targets.map((t) => t.id)).size !== targets.length ||
    new Set(targets.map((t) => resolve(xmpSidecarPath(t.path)))).size !== targets.length
  )
    throw new Error('Photos in this batch share a sidecar');
  const patch = parseTransferPatch(raw['patch']);
  applyTransferPatch('', patch); // Reject malformed patch XML before queueing any writes.
  return { targets, patch };
}

const hash = (xml: string): string => createHash('sha256').update(xml).digest('hex');

async function readSidecar(path: string): Promise<string> {
  try {
    await stat(xmpSidecarPath(path));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  }
  const read = await safeReadFile(xmpSidecarPath(path));
  if (!read.ok || !read.data) throw new Error(read.error ?? 'Could not read sidecar');
  return read.data.toString('utf8');
}

export function syncSummary(
  targets: readonly SyncTarget[],
  entries: readonly (SyncEntry | null)[],
) {
  return {
    applied: entries.filter((entry) => entry?.status === 'applied').map((entry) => entry!.id),
    failed: entries
      .filter((entry) => entry?.status === 'failed')
      .map((entry) => ({ id: entry!.id, reason: entry!.reason ?? 'Write failed' })),
    remaining: targets
      .filter((_, index) => !entries[index] || entries[index]?.status === 'prepared')
      .map((target) => target.id),
  };
}

function restoredEntries(
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
    return entry as SyncEntry;
  });
}

async function authorizedPath(target: SyncTarget): Promise<string> {
  const authorized = await resolveAndAuthorizePath(target.path);
  if (!authorized.ok) throw new Error(authorized.error);
  const allowed = await safeWriteAllowed(authorized.data);
  if (!allowed.ok) throw new Error(allowed.error ?? 'Photo is outside the library');
  if (!(await stat(authorized.data)).isFile()) throw new Error('Photo is not a file');
  return authorized.data;
}

export const batchAdjustmentSyncHandler: JobHandler = {
  async run(raw, ctx) {
    const payload = parseSyncPayload(raw);
    if (!ctx.saveCheckpoint) throw new Error('Batch sync requires a durable job ledger');
    const entries = restoredEntries(ctx.checkpoint, payload.targets);
    const save = async (): Promise<void> => {
      await ctx.saveCheckpoint!({ entries, ...syncSummary(payload.targets, entries) });
    };
    await save();
    await ctx.reportProgress(
      entries.filter((entry) => entry?.status === 'applied' || entry?.status === 'failed').length,
      payload.targets.length,
    );
    for (const [index, target] of payload.targets.entries()) {
      if (await ctx.shouldCancel())
        return {
          kind: 'cancelled',
          result: { ...syncSummary(payload.targets, entries), cancelled: true },
        };
      if (entries[index]?.status === 'applied' || entries[index]?.status === 'failed') continue;
      // Reading/merging failures are per-photo. Ledger failures abort the job:
      // continuing without a durable checkpoint would lose recovery guarantees.
      const prepared = await prepareTarget(target, payload.patch, entries[index]);
      entries[index] = prepared.entry;
      await save();
      if (prepared.write) {
        const result = await commitTarget(prepared);
        entries[index] = result.ok
          ? { ...prepared.entry, status: 'applied' }
          : { ...prepared.entry, status: 'failed', reason: result.error ?? 'XMP write failed' };
        await save();
      }
      await ctx.reportProgress(index + 1, payload.targets.length);
    }
    return { kind: 'done', result: { ...syncSummary(payload.targets, entries), cancelled: false } };
  },
};

type PreparedTarget =
  | { write: true; path: string; xml: string; entry: SyncEntry }
  | { write: false; entry: SyncEntry };

async function commitTarget(prepared: Extract<PreparedTarget, { write: true }>) {
  try {
    return hash(await readSidecar(prepared.path)) === prepared.entry.beforeHash
      ? await writeXmpAtomic(prepared.path, prepared.xml)
      : {
          ok: false,
          error: 'Sidecar changed before the batch write; review this photo before retrying',
        };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function prepareTarget(
  target: SyncTarget,
  patch: XmpTransferPatch,
  saved: SyncEntry | null,
): Promise<PreparedTarget> {
  try {
    const path = await authorizedPath(target);
    const current = await readSidecar(path);
    const currentHash = hash(current);
    if (saved?.afterHash === currentHash)
      return { write: false as const, entry: { ...saved, status: 'applied' as const } };
    if (saved && saved.beforeHash !== currentHash)
      throw new Error(
        'Sidecar changed while the operation was interrupted; review this photo before retrying',
      );
    const xml = applyTransferPatch(current, patch);
    return {
      write: xml !== current,
      path,
      xml,
      entry: {
        id: target.id,
        status: xml === current ? 'applied' : 'prepared',
        beforeHash: currentHash,
        afterHash: hash(xml),
      } as SyncEntry,
    };
  } catch (error) {
    return {
      write: false as const,
      entry: {
        id: target.id,
        status: 'failed' as const,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
