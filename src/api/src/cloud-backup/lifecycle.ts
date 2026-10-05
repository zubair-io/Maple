/** Record explicit human/retention intent BEFORE bytes or their asset row disappear (#4228). */
import * as path from 'node:path';
import { BackupRepository } from './repository.ts';
import { assetInventory, jailedFile, fileHash } from './inventory.ts';
import { listPairedSidecarsStrict } from '../fs/xmp-conflict.ts';
import { stat, realpath } from '../fs/mirrored.ts';
import { ObjectId } from '../db/object-id.ts';
import { relativeBackupPath } from './inventory.ts';
import {
  createLifecycleLease,
  claimExpiredLifecycle,
  assertLifecycleLease,
  releaseLifecycleLease,
  assertLifecycleClaim,
  releaseLifecycleClaim,
  type LifecycleLease,
} from './lifecycle-lease.ts';
import type { LifecycleCommit } from './lifecycle-commit.ts';
import { trashPurgeGuard, type TrashPurgeCandidate } from './trash-purge-admission.ts';

async function digest(file: string): Promise<string> {
  return fileHash(file);
}

function localPurgePaths(root: string, companion: string | null, files: string[]): string[] {
  const companionPaths = companion ? [relativeBackupPath(companion)] : [];
  const filePaths = files.map((file) => path.relative(root, file).split(path.sep).join('/'));
  return [...new Set([...companionPaths, ...filePaths])];
}

export async function prepareLifecycle(
  assetId: string,
  kind: 'trash' | 'restore',
  libraryId: string,
  sourcePath: string,
  repo = new BackupRepository(),
): Promise<string> {
  const id = crypto.randomUUID();
  await createLifecycleLease(id, assetId, kind, libraryId, sourcePath, repo);
  return id;
}
export async function recordLifecycleTarget(
  id: string,
  root: string,
  source: string,
  target: string,
  repo = new BackupRepository(),
): Promise<void> {
  const relative = relativeBackupPath(path.relative(root, target).split(path.sep).join('/'));
  const sha256 = await digest(source);
  const lease = await assertLifecycleLease(id);
  const result = await repo.db.write(
    `UPDATE backup_lifecycle SET target_path=?,source_sha256=? WHERE id=? AND phase='prepared'
      AND lease_owner=? AND lease_until>unixepoch('subsec')*1000`,
    [relative, sha256, id, lease.owner],
  );
  if (!result.changes) throw new Error('Lifecycle preparation lease lost');
}
/** Source retained after an ordinary failure: permit a later explicit retry. */
export async function finishLocalLifecycle(
  id: string,
  failed = false,
  _repo = new BackupRepository(),
): Promise<void> {
  await releaseLifecycleLease(id, failed);
}
export async function runLifecycleMove<T>(id: string, move: () => Promise<T>): Promise<T> {
  try {
    await assertLifecycleLease(id);
    return await move();
  } finally {
    // Callers include the DB commit in this scope. A failure after publication
    // leaves the preparation recoverable rather than cancelling its journal.
    await releaseLifecycleLease(id);
  }
}
export async function lifecycleCommit(id: string): Promise<LifecycleCommit> {
  const lease = await assertLifecycleLease(id);
  return { id, owner: lease.owner };
}
export async function fenceLifecycleMove(id: string): Promise<void> {
  await assertLifecycleLease(id);
}
/** Reconcile only recorded, verified destinations after a process interruption. */
export async function reconcileLifecycle(repo = new BackupRepository()): Promise<void> {
  const rows = await repo.db.read<LifecycleMove>(`SELECT l.*,f.path AS root FROM backup_lifecycle l
    JOIN folders f ON f.id=l.library_id WHERE l.phase='prepared' AND l.kind IN ('trash','restore')
    AND l.lease_until<=unixepoch('subsec')*1000`);
  for (const row of rows) {
    const lease = await claimExpiredLifecycle(row.id, repo);
    if (!lease) continue;
    try {
      await reconcileMove(row, repo, lease);
    } finally {
      await releaseLifecycleClaim(lease);
    }
  }
}

interface LifecycleMove {
  id: string;
  asset_id: string;
  library_id: string;
  source_path: string;
  target_path: string | null;
  source_sha256: string | null;
  kind: 'trash' | 'restore';
  root: string;
}
async function reconcileMove(
  row: LifecycleMove,
  repo: BackupRepository,
  lease: LifecycleLease,
): Promise<void> {
  if (!(await interruptedSourceAbsent(row, lease))) return;
  if (!row.target_path || !row.source_sha256) return;
  const source = path.join(row.root, relativeBackupPath(row.source_path));
  const target = path.join(row.root, relativeBackupPath(row.target_path));
  try {
    if (!(await verifiedLifecycleTarget(row))) return;
    await assertLifecycleClaim(lease);
    await applyRecoveredMove(row, source, target, repo, lease);
  } catch (error) {
    await repo.db.write(`UPDATE backup_lifecycle SET last_error=? WHERE id=?`, [
      error instanceof Error ? error.message.slice(0, 300) : 'Local relocation recovery failed',
      row.id,
    ]);
  }
}
async function interruptedSourceAbsent(
  row: LifecycleMove,
  lease: LifecycleLease,
): Promise<boolean> {
  const source = path.join(row.root, relativeBackupPath(row.source_path));
  try {
    await stat(source);
    await assertLifecycleClaim(lease);
    await releaseLifecycleClaim(lease, true);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}
async function verifiedLifecycleTarget(row: LifecycleMove): Promise<boolean> {
  const jailed = await jailedFile(row.root, row.target_path!);
  const canonicalTarget = path.join(await realpath(row.root), row.target_path!);
  return (
    jailed === canonicalTarget &&
    (await digest(jailed)) === row.source_sha256 &&
    (await jailedFile(row.root, row.target_path!)) === jailed
  );
}
async function applyRecoveredMove(
  row: LifecycleMove,
  source: string,
  target: string,
  repo: BackupRepository,
  lease: LifecycleLease,
): Promise<void> {
  const { markSoftDeleted, restoreFromTrash } = await import('../db/repos/assets.trash.ts');
  const args = {
    id: new ObjectId(row.asset_id),
    libraryId: new ObjectId(row.library_id),
    libraryRoot: row.root,
    newAbsPath: target,
    source: {
      libraryId: new ObjectId(row.library_id),
      path: path.posix.dirname(row.source_path) === '.' ? '' : path.posix.dirname(row.source_path),
      filename: path.posix.basename(row.source_path),
    },
    lifecycle: { id: row.id, owner: lease.owner },
    dbOverride: repo.db,
  };
  if (row.kind === 'trash') await markSoftDeleted({ ...args, originalAbsPath: source });
  else {
    const info = await stat(target);
    await restoreFromTrash({ ...args, size: info.size, mtimeMs: info.mtimeMs });
  }
}

async function inventoryPurge(assetId: string, repo: BackupRepository): Promise<void> {
  const destinations = await repo.destinations();
  // Local mirror deletes need a durable exact-path obligation too. No cloud
  // upload is issued for folder targets; the existing mirror writer owns them.
  for (const destination of destinations.filter((d) => d.kind === 'folder')) {
    for (const location of await assetInventory(assetId, destination.libraryId, repo)) {
      if (!location.relative_path.startsWith('.maple/trash/')) continue;
      const entry = await repo.ensureEntry(
        destination.id,
        assetId,
        location.ordinal,
        location.relative_path,
      );
      const original = path.join(location.root, location.relative_path);
      const sidecars = await listPairedSidecarsStrict(original).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        },
      );
      const files = localPurgePaths(location.root, location.apple_rendered_path, [
        original,
        ...sidecars,
      ]);
      const previous = entry.manifest
        ? (JSON.parse(entry.manifest) as {
            localFiles?: Array<{ path: string; sha256: string | null }>;
          })
        : null;
      const localFiles = await Promise.all(
        files.map(async (relative) => {
          try {
            return {
              path: relative,
              sha256: await fileHash(await jailedFile(location.root, relative)),
            };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return {
              path: relative,
              sha256: previous?.localFiles?.find((f) => f.path === relative)?.sha256 ?? null,
            };
          }
        }),
      );
      const merged = new Map((previous?.localFiles ?? []).map((file) => [file.path, file]));
      for (const file of localFiles) merged.set(file.path, file);
      await repo.db.write(`UPDATE backup_entries SET manifest=? WHERE id=?`, [
        JSON.stringify({ localFiles: [...merged.values()] }),
        entry.id,
      ]);
    }
  }
}

interface ReplacementLocation {
  libraryId: string;
  path: string;
  filename: string;
}

/** Normal permanent deletion intentionally includes all recorded locations. */
export async function preparePurge(assetId: string, repo = new BackupRepository()): Promise<void> {
  await inventoryPurge(assetId, repo);
  if (!(await recordPurgeIntent(assetId, repo)))
    throw new Error('Asset changed or has a pending backup lifecycle; retry permanent deletion.');
}

/** A stale Trash listing cannot authorize erasure after restore, reaping or relocation. */
export async function prepareTrashPurge(
  assetId: string,
  expected: TrashPurgeCandidate,
  repo = new BackupRepository(),
): Promise<boolean> {
  await inventoryPurge(assetId, repo);
  return recordPurgeIntent(assetId, repo, { trash: expected });
}

/** An upload may discard a redundant RAW only while its sole Trash location
 * is unchanged. Admission and backup fencing occur in one SQLite transaction. */
export async function prepareIdenticalReplacementPurge(
  assetId: string,
  location: ReplacementLocation,
  repo = new BackupRepository(),
): Promise<boolean> {
  await inventoryPurge(assetId, repo);
  return recordPurgeIntent(assetId, repo, { replacement: location });
}

async function recordPurgeIntent(
  assetId: string,
  repo: BackupRepository,
  candidate?: { replacement: ReplacementLocation } | { trash: TrashPurgeCandidate },
): Promise<boolean> {
  const at = new Date().toISOString();
  const intentId = crypto.randomUUID();
  const guard =
    candidate && 'replacement' in candidate
      ? {
          sql: `AND (SELECT COUNT(*) FROM asset_locations WHERE asset_id=a.id)=1
       AND a.apple_rendered_path IS NULL AND EXISTS
       (SELECT 1 FROM asset_locations WHERE asset_id=a.id AND library_id=? AND path=? AND filename=?)`,
          params: [
            candidate.replacement.libraryId,
            candidate.replacement.path,
            candidate.replacement.filename,
          ],
        }
      : candidate
        ? trashPurgeGuard(candidate.trash)
        : { sql: '', params: [] };
  const result = await repo.db.transaction([
    {
      sql: `INSERT INTO backup_lifecycle(id,asset_id,kind,phase,created_at)
        SELECT ?,a.id,'purge','applied',? FROM assets a WHERE a.id=? ${guard.sql}
        AND NOT EXISTS(SELECT 1 FROM backup_lifecycle WHERE asset_id=a.id
          AND (phase='prepared' OR lease_until>unixepoch('subsec')*1000))`,
      params: [intentId, at, assetId, ...guard.params],
    },
    {
      sql: `INSERT INTO backup_purges(destination_id,entry_id,record)
      SELECT e.destination_id,e.id,json_object('version',1,'libraryId',d.library_id,'entryId',e.id,
        'sequence',e.sequence+1,'purgedAt',?) FROM backup_entries e JOIN backup_destinations d ON d.id=e.destination_id
      WHERE e.asset_id=? AND EXISTS (SELECT 1 FROM backup_lifecycle WHERE id=?)
      ON CONFLICT(destination_id,entry_id) DO NOTHING`,
      params: [at, assetId, intentId],
    },
    {
      sql: `UPDATE backup_entries SET state='purged',sequence=sequence+1,snapshot_hash=NULL
        WHERE asset_id=? AND state!='purged' AND EXISTS (SELECT 1 FROM backup_lifecycle WHERE id=?)`,
      params: [assetId, intentId],
    },
  ]);
  return result[0].changes > 0;
}
