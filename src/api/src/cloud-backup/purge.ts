import * as path from 'node:path';
import { unlink, lstat, realpath } from '../fs/mirrored.ts';
import { type BackupEngine, jsonSource, entryPrefix } from './engine.ts';
import type { PurgeRecord, BackupObject, UploadCheckpoint, BackupProvider } from './provider.ts';
import { relativeBackupPath, fileHash, jailedFile } from './inventory.ts';
import type { BackupDestination, BackupRepository } from './repository.ts';

async function removeLocal(
  root: string,
  relative: string,
  expected: string | null,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  relativeBackupPath(relative);
  const canonical = await realpath(root);
  if (!(await existingPurgePath(canonical, relative))) return;
  const target = await jailedFile(canonical, relative);
  await verifyLocalPurge(canonical, relative, target, expected);
  signal?.throwIfAborted();
  try {
    await unlink(path.join(canonical, ...relative.split('/')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
async function existingPurgePath(canonical: string, relative: string): Promise<boolean> {
  for (const [index] of relative.split('/').entries()) {
    const candidate = path.join(canonical, ...relative.split('/').slice(0, index + 1));
    try {
      if ((await lstat(candidate)).isSymbolicLink())
        throw new Error('Mirror purge path contains a symlink');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}
async function verifyLocalPurge(
  canonical: string,
  relative: string,
  target: string,
  expected: string | null,
): Promise<void> {
  const before = await lstat(target);
  if (!expected || (await fileHash(target)) !== expected)
    throw new Error('Mirror purge file changed or lacks verified byte identity');
  const after = await lstat(await jailedFile(canonical, relative));
  if (
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error('Mirror purge file changed during verification');
}
type PurgeRow = Awaited<ReturnType<BackupRepository['purges']>>[number];

export async function drainPurges(
  engine: BackupEngine,
  destination: BackupDestination,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const pending = (await engine.repo.purges(destination.id)).filter((row) => !row.completed);
  if (destination.kind !== 'folder') {
    await drainRemoteBatch(engine, destination, pending, signal);
    return;
  }
  for (const row of pending) {
    signal?.throwIfAborted();
    const record: PurgeRecord = JSON.parse(row.record);
    try {
      await purgeFolder(engine, destination, row.entry_id, signal);
      await completePurge(engine, destination.id, record.entryId, row.revision, signal);
    } catch {
      await retryPurge(engine, destination.id, record.entryId, signal);
    }
  }
}
async function completePurge(
  engine: BackupEngine,
  destinationId: string,
  entryId: string,
  revision: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  await engine.repo.db.write(
    `UPDATE backup_purges SET completed=1,last_error=NULL WHERE destination_id=? AND entry_id=?
      AND revision=? AND NOT EXISTS (SELECT 1 FROM backup_entries WHERE id=? AND lease_until>?)`,
    [destinationId, entryId, revision, entryId, Date.now()],
  );
}
async function retryPurge(
  engine: BackupEngine,
  destinationId: string,
  entryId: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  await engine.repo.db.write(
    `UPDATE backup_purges SET last_error='Destination cleanup requires retry' WHERE destination_id=? AND entry_id=? AND completed=0`,
    [destinationId, entryId],
  );
}
interface RemotePurge {
  entryId: string;
  revision: number;
}
async function drainRemoteBatch(
  engine: BackupEngine,
  destination: BackupDestination,
  rows: PurgeRow[],
  signal?: AbortSignal,
): Promise<void> {
  if (!rows.length) return;
  const ready = new Map<string, RemotePurge>();
  try {
    const provider = await engine.provider(destination);
    for (const row of rows) {
      signal?.throwIfAborted();
      try {
        const record: PurgeRecord = JSON.parse(row.record);
        if (record.libraryId !== destination.libraryId || record.entryId !== row.entry_id)
          throw new Error('Purge identity does not match its destination entry');
        const revision = await publishPurgeMarker(engine, destination, provider, record, signal);
        const prefix = entryPrefix(record.libraryId, record.entryId);
        await removeSavedRemoteObjects(engine, destination.id, provider, prefix, signal);
        ready.set(prefix, { entryId: record.entryId, revision });
      } catch {
        await retryPurge(engine, destination.id, row.entry_id, signal);
      }
    }
    // Catalog objects remain entry-keyed. Mirror files are removed by their
    // exact paths from the current manifest before this shared catalog sweep.
    const libraryPrefix = `libraries/${destination.libraryId}/entries/`;
    await scanRemoteBatch(engine, destination.id, provider, libraryPrefix, ready, true, signal);
    await scanRemoteBatch(engine, destination.id, provider, libraryPrefix, ready, false, signal);
    for (const row of ready.values())
      await completePurge(engine, destination.id, row.entryId, row.revision, signal);
  } catch {
    signal?.throwIfAborted();
    // A failed or incomplete inventory cannot prove absence for any entry.
    for (const row of rows) await retryPurge(engine, destination.id, row.entry_id, signal);
  }
}
async function scanRemoteBatch(
  engine: BackupEngine,
  destinationId: string,
  provider: BackupProvider,
  libraryPrefix: string,
  ready: Map<string, RemotePurge>,
  remove: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (!ready.size) return;
  for await (const object of provider.list(libraryPrefix, signal)) {
    signal?.throwIfAborted();
    const prefix = object.key.split('/').slice(0, 4).join('/') + '/';
    const row = ready.get(prefix);
    if (!row || !object.key.startsWith(libraryPrefix)) continue;
    try {
      if (!remove) throw new Error('Purge cleanup still pending');
      await provider.remove(object, signal);
    } catch {
      await retryPurge(engine, destinationId, row.entryId, signal);
      ready.delete(prefix);
    }
  }
}

async function purgeFolder(
  engine: BackupEngine,
  destination: BackupDestination,
  entryId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!destination.path) throw new Error('Mirror root unavailable');
  const [entry] = await engine.repo.db.read<{ manifest: string | null }>(
    'SELECT manifest FROM backup_entries WHERE destination_id=? AND id=?',
    [destination.id, entryId],
  );
  const manifest = entry?.manifest
    ? (JSON.parse(entry.manifest) as {
        localFiles: Array<{ path: string; sha256: string | null }>;
      })
    : null;
  if (!manifest) throw new Error('Mirror purge inventory unavailable');
  for (const file of manifest.localFiles) {
    signal?.throwIfAborted();
    await removeLocal(destination.path, file.path, file.sha256, signal);
  }
}

async function publishPurgeMarker(
  engine: BackupEngine,
  destination: BackupDestination,
  provider: BackupProvider,
  record: PurgeRecord,
  signal?: AbortSignal,
): Promise<number> {
  // Disabled or disconnected destinations still owe erasure. Connection
  // failures leave an explicit obligation, never a fabricated success.
  signal?.throwIfAborted();
  const source = jsonSource(record);
  const key = `purges/${record.entryId}.json`;
  const savedRecord = await engine.repo.object(destination.id, key);
  const existing = await provider.inspect(key, signal, savedRecord.object?.locator);
  signal?.throwIfAborted();
  if (!existing) {
    const object = await provider.publish(key, source, {
      signal,
      checkpoint: savedRecord.checkpoint,
      saveCheckpoint: async (checkpoint) =>
        engine.repo.saveObject(destination.id, record.entryId, key, null, checkpoint),
    });
    // If publication won a cancellation race, preserve its locator as an
    // erasure obligation before exiting. Shutdown drains this SQLite write.
    await engine.repo.saveObject(destination.id, record.entryId, key, object, null);
  } else if (existing.sha256 !== source.sha256) throw new Error('Purge record integrity mismatch');
  signal?.throwIfAborted();
  await engine.repo.db.write(
    `UPDATE backup_purges SET published=1 WHERE destination_id=? AND entry_id=?`,
    [destination.id, record.entryId],
  );
  const [current] = await engine.repo.db.read<{ revision: number }>(
    `SELECT revision FROM backup_purges WHERE destination_id=? AND entry_id=?`,
    [destination.id, record.entryId],
  );
  return current!.revision;
}

async function removeSavedRemoteObjects(
  engine: BackupEngine,
  destinationId: string,
  provider: BackupProvider,
  prefix: string,
  signal?: AbortSignal,
): Promise<void> {
  const entryId = prefix.split('/')[3];
  const objectColumns = `key,object,checkpoint`;
  const catalogObjects = await engine.repo.db.read<{
    key: string;
    object: string | null;
    checkpoint: string | null;
  }>(
    `SELECT ${objectColumns} FROM backup_objects
        WHERE destination_id=? AND key>=? AND key<?`,
    [destinationId, prefix, prefix.slice(0, -1) + '0'],
  );
  const entryObjects = await engine.repo.db.read<{
    key: string;
    object: string | null;
    checkpoint: string | null;
  }>(
    `SELECT ${objectColumns} FROM backup_objects
        WHERE destination_id=? AND entry_id=? AND key<>?`,
    [destinationId, entryId, `purges/${entryId}.json`],
  );
  const pending = [
    ...new Map([...catalogObjects, ...entryObjects].map((row) => [row.key, row])).values(),
  ];
  for (const saved of pending) {
    signal?.throwIfAborted();
    if (saved.checkpoint) {
      await provider.abort(JSON.parse(saved.checkpoint) as UploadCheckpoint, signal);
    }
    signal?.throwIfAborted();
    // Persisted IDs remain erasure obligations even if a user moved the
    // object out of the root. The adapter then reports blocked ancestry.
    if (saved.object) await provider.remove(JSON.parse(saved.object) as BackupObject, signal);
  }
}
