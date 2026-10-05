import * as path from 'node:path';
import { unlink, lstat, realpath } from '../fs/mirrored.ts';
import { type BackupEngine, jsonSource, entryPrefix } from './engine.ts';
import type { PurgeRecord, BackupObject, UploadCheckpoint } from './provider.ts';
import { relativeBackupPath, fileHash, jailedFile } from './inventory.ts';
import type { BackupDestination } from './repository.ts';

async function removeLocal(root: string, relative: string, expected: string | null): Promise<void> {
  relativeBackupPath(relative);
  const canonical = await realpath(root);
  for (const [index] of relative.split('/').entries()) {
    const candidate = path.join(canonical, ...relative.split('/').slice(0, index + 1));
    try {
      if ((await lstat(candidate)).isSymbolicLink())
        throw new Error('Mirror purge path contains a symlink');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  const target = await jailedFile(canonical, relative);
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
  try {
    await unlink(path.join(canonical, ...relative.split('/')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
export async function drainPurges(
  engine: BackupEngine,
  destination: BackupDestination,
  signal?: AbortSignal,
): Promise<void> {
  for (const row of await engine.repo.purges(destination.id)) {
    if (row.completed) continue;
    const record: PurgeRecord = JSON.parse(row.record);
    let revision = row.revision;
    try {
      if (destination.kind === 'folder') {
        if (!destination.path) throw new Error('Mirror root unavailable');
        const entries = await engine.repo.entries(destination.id);
        const entry = entries.find((e) => e.id === row.entry_id);
        const manifest = entry?.manifest
          ? (JSON.parse(entry.manifest) as {
              localFiles: Array<{ path: string; sha256: string | null }>;
            })
          : null;
        if (!manifest) throw new Error('Mirror purge inventory unavailable');
        for (const file of manifest.localFiles)
          await removeLocal(destination.path, file.path, file.sha256);
      } else {
        // Disabled or disconnected destinations still owe erasure. Connection
        // failures leave an explicit obligation, never a fabricated success.
        const provider = await engine.provider(destination);
        const source = jsonSource(record);
        const key = `purges/${record.entryId}.json`;
        const savedRecord = await engine.repo.object(destination.id, key);
        const existing = await provider.inspect(key, signal, savedRecord.object?.locator);
        if (!existing) {
          const object = await provider.publish(key, source, {
            signal,
            checkpoint: savedRecord.checkpoint,
            saveCheckpoint: async (checkpoint) =>
              engine.repo.saveObject(destination.id, record.entryId, key, null, checkpoint),
          });
          await engine.repo.saveObject(destination.id, record.entryId, key, object, null);
        } else if (existing.sha256 !== source.sha256)
          throw new Error('Purge record integrity mismatch');
        await engine.repo.db.write(
          `UPDATE backup_purges SET published=1 WHERE destination_id=? AND entry_id=?`,
          [destination.id, record.entryId],
        );
        const [current] = await engine.repo.db.read<{ revision: number }>(
          `SELECT revision FROM backup_purges WHERE destination_id=? AND entry_id=?`,
          [destination.id, record.entryId],
        );
        revision = current!.revision;
        const prefix = entryPrefix(record.libraryId, record.entryId);
        const pending = await engine.repo.db.read<{
          key: string;
          object: string | null;
          checkpoint: string | null;
        }>(
          `SELECT key,object,checkpoint FROM backup_objects
          WHERE destination_id=? AND substr(key,1,?)=?`,
          [destination.id, prefix.length, prefix],
        );
        for (const saved of pending) {
          if (saved.checkpoint) {
            await provider.abort(JSON.parse(saved.checkpoint) as UploadCheckpoint, signal);
          }
          // Persisted IDs remain erasure obligations even if a user moved the
          // object out of the root. The adapter then reports blocked ancestry.
          if (saved.object) await provider.remove(JSON.parse(saved.object) as BackupObject, signal);
        }
        for await (const object of provider.list(prefix, signal))
          await provider.remove(object, signal);
        // A transfer already inside an external request may still complete.
        // Keep the obligation open until its renewable lease has elapsed.
        const entries = await engine.repo.entries(destination.id);
        if (entries.some((e) => e.id === record.entryId && e.lease_until > Date.now())) continue;
        const remaining: BackupObject[] = [];
        for await (const object of provider.list(prefix, signal)) remaining.push(object);
        if (remaining.length) throw new Error('Purge cleanup still pending');
      }
      await engine.repo.db.write(
        `UPDATE backup_purges SET completed=1,last_error=NULL WHERE destination_id=? AND entry_id=?
        AND revision=? AND NOT EXISTS (SELECT 1 FROM backup_entries WHERE id=? AND lease_until>?)`,
        [destination.id, record.entryId, revision, record.entryId, Date.now()],
      );
    } catch {
      await engine.repo.db.write(
        `UPDATE backup_purges SET last_error='Destination cleanup requires retry' WHERE destination_id=? AND entry_id=?`,
        [destination.id, record.entryId],
      );
    }
  }
}
