/** Per-photo preparation and conditional sidecar write; originals are never opened for writing. */
import { createHash } from 'node:crypto';
import { stat } from '../../fs/mirrored.ts';
import { xmpSidecarPath, writeXmpWithPrecondition } from '../../fs/xmp.ts';
import { safeReadFile, safeWriteAllowed } from '../../fs/root.ts';
import { resolveAndAuthorizePath } from '../../routes/xmp-path-auth.ts';
import { applyTransferPatch, type XmpTransferPatch } from '../../xmp/transfer-patch.ts';
import { relativeWhiteBalancePatch, type WhiteBalanceCorrection } from './batch-white-balance.ts';
import type { SyncTarget } from './batch-sync-payload.ts';
import type { SyncEntry } from './batch-sync-ledger.ts';

const hash = (xml: string): string => createHash('sha256').update(xml).digest('hex');
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const changed = 'Sidecar changed before the batch write; review this photo before retrying';

async function readSidecar(path: string): Promise<{ xml: string; mtime: number | null }> {
  const sidecar = xmpSidecarPath(path);
  const info = await stat(sidecar).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  });
  if (!info) return { xml: '', mtime: null };
  const read = await safeReadFile(sidecar);
  if (!read.ok || !read.data) throw new Error(read.error ?? 'Could not read sidecar');
  return { xml: read.data.toString('utf8'), mtime: Math.floor(info.mtimeMs / 1000) };
}

async function authorizedPath(target: SyncTarget): Promise<string> {
  const authorized = await resolveAndAuthorizePath(target.path);
  if (!authorized.ok) throw new Error(authorized.error);
  const allowed = await safeWriteAllowed(authorized.data);
  if (!allowed.ok) throw new Error(allowed.error ?? 'Photo is outside the library');
  if (!(await stat(authorized.data)).isFile()) throw new Error('Photo is not a file');
  return authorized.data;
}

export type PreparedTarget =
  | { action: 'write'; path: string; xml: string; mtime: number | null; entry: SyncEntry }
  | { action: 'publish'; path: string; entry: SyncEntry }
  | { action: 'none'; entry: SyncEntry };

export async function prepareTarget(
  target: SyncTarget,
  patch: XmpTransferPatch,
  saved: SyncEntry | null,
  correction?: WhiteBalanceCorrection,
): Promise<PreparedTarget> {
  try {
    const path = await authorizedPath(target);
    const current = await readSidecar(path);
    const currentHash = hash(current.xml);
    // An unacknowledged write is already durable. Publish its invalidation again,
    // then acknowledge; never apply a relative correction to the written result.
    if (saved?.afterHash === currentHash)
      return { action: 'publish', path, entry: { ...saved, status: 'prepared' } };
    if (saved && saved.beforeHash !== currentHash)
      throw new Error(
        'Sidecar changed while the operation was interrupted; review this photo before retrying',
      );
    const preparedPatch =
      saved?.patch ?? target.patch ?? (await relativeWhiteBalancePatch(path, patch, correction));
    const xml = applyTransferPatch(current.xml, preparedPatch);
    const entry: SyncEntry = {
      id: target.id,
      status: xml === current.xml ? 'applied' : 'prepared',
      patch: preparedPatch,
      beforeHash: currentHash,
      afterHash: hash(xml),
    };
    return xml === current.xml
      ? { action: 'none', entry }
      : { action: 'write', path, xml, mtime: current.mtime, entry };
  } catch (error) {
    // Retain a frozen relative patch when the filesystem changes during recovery.
    return {
      action: 'none',
      entry: { ...(saved ?? {}), id: target.id, status: 'failed', reason: errorMessage(error) },
    };
  }
}

export async function commitTarget(prepared: Extract<PreparedTarget, { action: 'write' }>) {
  try {
    if (hash((await readSidecar(prepared.path)).xml) !== prepared.entry.beforeHash)
      return { ok: false, error: changed };
    const result = await writeXmpWithPrecondition(
      prepared.path,
      prepared.xml,
      prepared.mtime,
      'Maple batch sync',
      prepared.mtime === null,
    );
    if (result.kind === 'ok') return { ok: true };
    return { ok: false, error: result.kind === 'conflict' ? changed : result.error };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
