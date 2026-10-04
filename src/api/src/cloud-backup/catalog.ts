import { createHash } from 'node:crypto';
import type { BackupManifest, BackupObject, BackupProvider, PurgeRecord } from './provider.ts';
import { relativeBackupPath } from './inventory.ts';
import { entryPrefix } from './engine.ts';

const ID = /^[a-f0-9-]{24,36}$/;
/** Catalog bytes are untrusted even inside an owned root. Verify before parsing. */
export async function readObjectJson(
  provider: BackupProvider,
  object: BackupObject,
  signal?: AbortSignal,
): Promise<unknown> {
  if (object.size > 2 * 1024 * 1024)
    throw new Error('Backup catalog exceeds the 2 MiB record limit');
  const reader = (await provider.download(object, signal)).getReader();
  const chunks: Uint8Array[] = [];
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > object.size || bytes > 2 * 1024 * 1024)
        throw new Error('Backup catalog size mismatch');
      hash.update(value);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  if (bytes !== object.size || hash.digest('hex') !== object.sha256)
    throw new Error('Backup catalog checksum mismatch');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid backup catalog');
  return value as Record<string, unknown>;
}
export function parsePurge(value: unknown): PurgeRecord {
  const row = record(value);
  if (
    row.version !== 1 ||
    typeof row.libraryId !== 'string' ||
    !ID.test(row.libraryId) ||
    typeof row.entryId !== 'string' ||
    !ID.test(row.entryId) ||
    typeof row.sequence !== 'number' ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    typeof row.purgedAt !== 'string' ||
    !Number.isFinite(Date.parse(row.purgedAt))
  )
    throw new Error('Invalid backup purge record');
  return row as unknown as PurgeRecord;
}
export function parseManifest(value: unknown): BackupManifest {
  const row = record(value);
  if (
    row.version !== 1 ||
    typeof row.libraryId !== 'string' ||
    !ID.test(row.libraryId) ||
    typeof row.entryId !== 'string' ||
    !ID.test(row.entryId) ||
    typeof row.assetId !== 'string' ||
    !ID.test(row.assetId) ||
    typeof row.sequence !== 'number' ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    !['active', 'trash'].includes(String(row.state)) ||
    typeof row.hidden !== 'boolean' ||
    typeof row.originalPath !== 'string' ||
    typeof row.currentPath !== 'string' ||
    !Array.isArray(row.files) ||
    !row.files.length ||
    row.files.length > 512 ||
    (row.deletedAt !== null &&
      (typeof row.deletedAt !== 'string' || !Number.isFinite(Date.parse(row.deletedAt))))
  ) {
    throw new Error('Invalid backup manifest');
  }
  relativeBackupPath(row.originalPath);
  relativeBackupPath(row.currentPath);
  const names = new Set<string>();
  for (const file of row.files) {
    const f = record(file),
      object = record(f.object);
    if (
      typeof f.path !== 'string' ||
      !['original', 'sidecar', 'companion'].includes(String(f.role)) ||
      typeof object.key !== 'string' ||
      !object.key.startsWith(entryPrefix(row.libraryId, row.entryId) + 'blobs/') ||
      typeof object.locator !== 'string' ||
      !object.locator ||
      typeof object.size !== 'number' ||
      !Number.isSafeInteger(object.size) ||
      object.size < 0 ||
      typeof object.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(object.sha256)
    ) {
      throw new Error('Invalid backup file');
    }
    if (object.key !== `${entryPrefix(row.libraryId, row.entryId)}blobs/${object.sha256}`)
      throw new Error('Backup blob key does not match its checksum');
    relativeBackupPath(f.path);
    const normalized = f.path.normalize('NFC').toLocaleLowerCase('en-US');
    if (names.has(normalized)) throw new Error('Backup manifest contains colliding paths');
    names.add(normalized);
  }
  if (row.files.filter((f) => record(f).role === 'original').length !== 1)
    throw new Error('Backup manifest must have one original');
  if (record(row.files.find((f) => record(f).role === 'original')).path !== row.currentPath)
    throw new Error('Backup original does not match its catalog path');
  if (
    (row.state === 'active' && row.deletedAt !== null) ||
    (row.state === 'trash' && !row.currentPath.startsWith('.maple/trash/'))
  )
    throw new Error('Backup lifecycle metadata is inconsistent');
  return row as unknown as BackupManifest;
}
export async function readPurges(
  provider: BackupProvider,
  signal?: AbortSignal,
): Promise<PurgeRecord[]> {
  const result: PurgeRecord[] = [];
  for await (const object of provider.list('purges/', signal)) {
    if (result.length >= 100_000)
      throw new Error('Purge inventory requires a larger recovery batch');
    const purge = parsePurge(await readObjectJson(provider, object, signal));
    if (object.key !== `purges/${purge.entryId}.json`)
      throw new Error('Purge key does not match its record');
    result.push(purge);
  }
  return result;
}
export async function readRemoteCatalog(
  provider: BackupProvider,
  signal?: AbortSignal,
): Promise<{ entries: BackupManifest[]; purges: PurgeRecord[] }> {
  await provider.probe(signal);
  const first = await readPurges(provider, signal);
  const entries: BackupManifest[] = [];
  const seen = new Set<string>();
  for await (const object of provider.list('libraries/', signal)) {
    if (!object.key.includes('/manifests/') || !object.key.endsWith('.json')) continue;
    if (entries.length >= 100_000) throw new Error('Catalog requires a larger recovery batch');
    const manifest = parseManifest(await readObjectJson(provider, object, signal));
    if (
      object.key !==
      `${entryPrefix(manifest.libraryId, manifest.entryId)}manifests/${manifest.sequence}.json`
    )
      throw new Error('Catalog key does not match its manifest');
    if (seen.has(object.key))
      throw new Error('Conflicting backup catalog objects require operator review');
    seen.add(object.key);
    entries.push(manifest);
  }
  const purgeVersions = new Map<string, PurgeRecord>();
  for (const purge of [...first, ...(await readPurges(provider, signal))]) {
    if ((purgeVersions.get(purge.entryId)?.sequence ?? 0) < purge.sequence)
      purgeVersions.set(purge.entryId, purge);
  }
  const purges = [...purgeVersions.values()];
  const removed = new Set(purges.map((p) => p.entryId));
  return { entries: entries.filter((e) => !removed.has(e.entryId)), purges };
}
export function latestManifests(
  entries: BackupManifest[],
  selection?: { entryId: string; sequence: number },
): BackupManifest[] {
  if (selection) {
    const chosen = entries.find(
      (e) => e.entryId === selection.entryId && e.sequence === selection.sequence,
    );
    if (!chosen) throw new Error('Selected backup version is unavailable or purged');
    return [chosen];
  }
  const latest = new Map<string, BackupManifest>();
  for (const entry of entries)
    if ((latest.get(entry.entryId)?.sequence ?? 0) < entry.sequence)
      latest.set(entry.entryId, entry);
  return [...latest.values()];
}
