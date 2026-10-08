import { createHash } from 'node:crypto';
import type { BackupManifest, BackupObject, BackupProvider, PurgeRecord } from './provider.ts';
import { relativeBackupPath } from './inventory.ts';
import { entryPrefix } from './engine.ts';

const ID = /^[a-f0-9-]{24,36}$/;
/** Catalog bytes are untrusted even inside an owned root. Verify before parsing. */
async function readObjectJson(
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
function stringValue(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Invalid backup catalog string');
  return value;
}
function catalogId(value: unknown): string {
  const id = stringValue(value);
  if (!ID.test(id)) throw new Error('Invalid backup catalog identity');
  return id;
}
function sequenceValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('Invalid backup catalog sequence');
  return value;
}
function timestampValue(value: unknown): string {
  const timestamp = stringValue(value);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid backup catalog timestamp');
  return timestamp;
}
function identity(row: Record<string, unknown>) {
  if (row.version !== 1) throw new Error('Invalid backup catalog version');
  return {
    libraryId: catalogId(row.libraryId),
    entryId: catalogId(row.entryId),
    sequence: sequenceValue(row.sequence),
  };
}
function parsePurge(value: unknown): PurgeRecord {
  const row = record(value);
  return { version: 1, ...identity(row), purgedAt: timestampValue(row.purgedAt) };
}
/** Per-entry recovery fences must not re-download the whole purge inventory. */
export async function readEntryPurge(
  provider: BackupProvider,
  entry: Pick<BackupManifest, 'libraryId' | 'entryId'>,
  signal?: AbortSignal,
): Promise<PurgeRecord | null> {
  const key = `purges/${entry.entryId}.json`;
  const object = await provider.inspect(key, signal);
  if (!object) return null;
  if (object.key !== key) throw new Error('Backup purge key mismatch');
  const purge = parsePurge(await readObjectJson(provider, object, signal));
  if (purge.libraryId !== entry.libraryId || purge.entryId !== entry.entryId)
    throw new Error('Backup purge record identity mismatch');
  return purge;
}
function parseFile(value: unknown, libraryId: string): BackupManifest['files'][number] {
  const file = record(value),
    object = record(file.object);
  const role = stringValue(file.role);
  if (!['original', 'sidecar', 'companion'].includes(role))
    throw new Error('Invalid backup file role');
  const path = relativeBackupPath(stringValue(file.path));
  const sha256 = stringValue(object.sha256);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid backup file checksum');
  const key = stringValue(object.key);
  if (key !== `mirror/${libraryId}/${path}`)
    throw new Error('Backup mirror key does not match its library-relative path');
  if (typeof object.size !== 'number' || !Number.isSafeInteger(object.size) || object.size < 0)
    throw new Error('Invalid backup file size');
  return {
    path,
    role: role as BackupManifest['files'][number]['role'],
    object: { key, locator: stringValue(object.locator), sha256, size: object.size },
  };
}
function manifestFiles(value: unknown, libraryId: string): BackupManifest['files'] {
  if (!Array.isArray(value) || !value.length || value.length > 512)
    throw new Error('Invalid backup manifest files');
  const files = value.map((file) => parseFile(file, libraryId));
  const names = new Set<string>();
  for (const file of files) {
    const normalized = file.path.normalize('NFC').toLocaleLowerCase('en-US');
    if (names.has(normalized)) throw new Error('Backup manifest contains colliding paths');
    names.add(normalized);
  }
  return files;
}
function validateManifestLifecycle(manifest: BackupManifest): void {
  const originals = manifest.files.filter((file) => file.role === 'original');
  if (originals.length !== 1) throw new Error('Backup manifest must have one original');
  if (originals[0]!.path !== manifest.currentPath)
    throw new Error('Backup original does not match its catalog path');
  if (
    (manifest.state === 'active' && manifest.deletedAt !== null) ||
    (manifest.state === 'trash' && !manifest.currentPath.startsWith('.maple/trash/'))
  )
    throw new Error('Backup lifecycle metadata is inconsistent');
}
export function parseManifest(value: unknown): BackupManifest {
  const row = record(value),
    ids = identity(row);
  if (row.state !== 'active' && row.state !== 'trash')
    throw new Error('Invalid backup manifest state');
  if (typeof row.hidden !== 'boolean') throw new Error('Invalid backup manifest visibility');
  const manifest: BackupManifest = {
    version: 1,
    ...ids,
    assetId: catalogId(row.assetId),
    state: row.state,
    hidden: row.hidden,
    originalPath: relativeBackupPath(stringValue(row.originalPath)),
    currentPath: relativeBackupPath(stringValue(row.currentPath)),
    deletedAt: row.deletedAt === null ? null : timestampValue(row.deletedAt),
    files: manifestFiles(row.files, ids.libraryId),
  };
  validateManifestLifecycle(manifest);
  return manifest;
}
async function readPurges(provider: BackupProvider, signal?: AbortSignal): Promise<PurgeRecord[]> {
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
  // The second read fences tombstones published during the paged library scan.
  // Keep both observations: a concurrent purge must not reappear in the preview.
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
