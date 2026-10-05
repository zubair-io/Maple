import type { BackupRepository } from './repository.ts';

const LEASE_MS = 120_000;
const RENEW_MS = 20_000;
const NOW = "unixepoch('subsec')*1000";

export interface LifecycleLease {
  id: string;
  owner: string;
  repo: BackupRepository;
  timer: ReturnType<typeof setInterval>;
  renewing: Promise<void> | null;
  error: Error | null;
}
// Handles only schedule renewal. Eligibility for recovery is decided by SQLite,
// including when the HTTP process and background child have separate maps.
const handles = new Map<string, LifecycleLease>();

function beginRenewal(id: string, owner: string, repo: BackupRepository): LifecycleLease {
  const timer = setInterval(() => {
    if (lease.renewing) return;
    lease.renewing = renewLifecycleLease(id, lease)
      .catch((error: unknown) => {
        lease.error = error instanceof Error ? error : new Error('Lifecycle renewal failed');
        clearInterval(timer);
      })
      .finally(() => {
        lease.renewing = null;
      });
  }, RENEW_MS);
  timer.unref();
  const lease: LifecycleLease = { id, owner, repo, timer, renewing: null, error: null };
  return lease;
}

async function renewLifecycleLease(id: string, lease: LifecycleLease): Promise<void> {
  const result = await lease.repo.db.write(
    `UPDATE backup_lifecycle SET lease_until=${NOW}+? WHERE id=? AND phase IN ('prepared','applied')
      AND lease_owner=? AND lease_until>${NOW}`,
    [LEASE_MS, id, lease.owner],
  );
  if (!result.changes) throw new Error('Lifecycle preparation lease lost');
}

export async function createLifecycleLease(
  id: string,
  assetId: string,
  kind: 'trash' | 'restore',
  libraryId: string,
  sourcePath: string,
  repo: BackupRepository,
): Promise<void> {
  const owner = crypto.randomUUID();
  await repo.db.transaction([
    {
      sql: `INSERT INTO backup_lifecycle(id,asset_id,library_id,source_path,kind,phase,created_at,lease_owner,lease_until)
        VALUES(?,?,?,?,?,'prepared',?, ?,${NOW}+?)`,
      params: [id, assetId, libraryId, sourcePath, kind, new Date().toISOString(), owner, LEASE_MS],
    },
    {
      sql: `UPDATE backup_entries SET sequence=sequence+1,snapshot_hash=NULL,lease_owner=NULL,lease_until=0
        WHERE asset_id=? AND source_path=? AND destination_id IN
        (SELECT id FROM backup_destinations WHERE library_id=?) AND state!='purged'`,
      params: [assetId, sourcePath, libraryId],
    },
  ]);
  handles.set(id, beginRenewal(id, owner, repo));
}

export async function claimExpiredLifecycle(
  id: string,
  repo: BackupRepository,
): Promise<LifecycleLease | null> {
  const owner = crypto.randomUUID();
  const result = await repo.db.write(
    `UPDATE backup_lifecycle SET lease_owner=?,lease_until=${NOW}+?
      WHERE id=? AND phase='prepared' AND lease_until<=${NOW}`,
    [owner, LEASE_MS, id],
  );
  return result.changes ? beginRenewal(id, owner, repo) : null;
}

export async function assertLifecycleLease(id: string): Promise<LifecycleLease> {
  const lease = handles.get(id);
  if (!lease) throw new Error('Lifecycle preparation lease unavailable');
  await assertLifecycleClaim(lease);
  return lease;
}

export async function assertLifecycleClaim(lease: LifecycleLease): Promise<void> {
  if (lease.error) throw lease.error;
  // Renew at a destructive boundary so expiry cannot be imminent at unlink.
  await renewLifecycleLease(lease.id, lease);
}

export async function releaseLifecycleLease(id: string, failed = false): Promise<void> {
  const lease = handles.get(id);
  if (!lease) return;
  handles.delete(id);
  await releaseLifecycleClaim(lease, failed);
}

export async function releaseLifecycleClaim(lease: LifecycleLease, failed = false): Promise<void> {
  clearInterval(lease.timer);
  await lease.renewing;
  await lease.repo.db.write(
    `UPDATE backup_lifecycle SET phase=CASE WHEN phase='prepared' THEN ? ELSE phase END,
      lease_owner=NULL,lease_until=0 WHERE id=? AND phase IN ('prepared','applied') AND lease_owner=?`,
    [failed ? 'cancelled' : 'prepared', lease.id, lease.owner],
  );
}
