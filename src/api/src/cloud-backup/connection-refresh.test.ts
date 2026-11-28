/**
 * A reconnect fences in-flight transfers before the OAuth callback responds,
 * and invalidates and re-arms every entry afterwards, in order. Real SQLite.
 */
import { expect, test } from 'bun:test';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { BackupRepository } from './repository.ts';
import { ConnectionRefresh } from './connection-refresh.ts';

const PARKED =
  "Google expired or revoked Maple's Drive authorization (invalid_grant) at 2026-11-14T19:14:01Z. Reconnect Google Drive to resume backup.";

async function parkedLibrary(
  live: Awaited<ReturnType<typeof createLiveTestDatabase>>,
  leaseUntil = Date.now() + 60_000,
) {
  const libraryId = insertFolder(live.db, { path: '/library' });
  const repo = new BackupRepository(live.handle);
  const { id } = await repo.createDestination({
    libraryId,
    kind: 'google-drive',
    name: 'Drive',
    path: null,
  });
  const assets = [insertAsset(live.db), insertAsset(live.db)];
  for (const assetId of assets) {
    insertLocation(live.db, { assetId, libraryId, filename: `${assetId}.dng`, path: '' });
    await repo.ensureEntry(id, assetId, 0, `${assetId}.dng`);
  }
  live.db
    .query(
      `UPDATE backup_entries SET last_error=?,error_kind='connection',attempts=9,retry_at=?,
        lease_owner='old-worker',lease_until=? WHERE destination_id=?`,
    )
    .run(PARKED, Date.now() + 3_600_000, leaseUntil, id);
  for (const assetId of assets)
    live.db
      .query(
        `INSERT INTO stage_state(asset_id,stage,version,attempts,dead) VALUES(?,'cloud-backup',1,5,1)`,
      )
      .run(assetId);
  return { repo, id, generation: (await repo.destination(id))!.generation };
}

function entries(live: Awaited<ReturnType<typeof createLiveTestDatabase>>, id: string) {
  return live.db
    .query<
      { sequence: number; lastError: string | null; leaseOwner: string | null; retryAt: number },
      [string]
    >(
      `SELECT sequence,last_error AS lastError,lease_owner AS leaseOwner,retry_at AS retryAt
        FROM backup_entries WHERE destination_id=? ORDER BY id`,
    )
    .all(id);
}

test('a reconnect fences at once, then invalidates and clears parked errors after the response', async () => {
  const live = await createLiveTestDatabase();
  try {
    const { repo, id, generation } = await parkedLibrary(live);
    const refresh = new ConnectionRefresh(repo);

    await refresh.changed(id);
    expect((await repo.destination(id))!.generation).toBe(generation + 1);
    await refresh.restored(id);
    await refresh.settled(id);

    expect(entries(live, id)).toEqual([
      { sequence: 2, lastError: null, leaseOwner: null, retryAt: 0 },
      { sequence: 2, lastError: null, leaseOwner: null, retryAt: 0 },
    ]);
    const stage = live.db
      .query<
        { version: number; dead: number },
        []
      >(`SELECT version,dead FROM stage_state WHERE stage='cloud-backup'`)
      .all();
    expect(stage).toEqual([
      { version: 0, dead: 0 },
      { version: 0, dead: 0 },
    ]);
    const [errors] = live.db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM backup_entry_errors`)
      .all();
    expect(errors!.n).toBe(0);
  } finally {
    live.close();
  }
});

test('a failed refresh step is logged and does not block the next one', async () => {
  const live = await createLiveTestDatabase();
  try {
    const { repo, id } = await parkedLibrary(live, 0);
    const failing = Object.create(repo) as BackupRepository;
    failing.invalidateEntries = () => Promise.reject(new Error('disk full'));
    const refresh = new ConnectionRefresh(failing);

    await refresh.changed(id);
    await refresh.restored(id);
    await refresh.settled(id);

    expect(entries(live, id).map((entry) => entry.lastError)).toEqual([null, null]);
  } finally {
    live.close();
  }
});

test('reconnecting the same client fences transfers but keeps verified entries verified', async () => {
  const live = await createLiveTestDatabase();
  try {
    const { repo, id, generation } = await parkedLibrary(live, 0);
    live.db
      .query(`UPDATE backup_entries SET verified_sequence=sequence WHERE destination_id=?`)
      .run(id);
    const refresh = new ConnectionRefresh(repo);

    await refresh.fenced(id);
    await refresh.restored(id);
    await refresh.settled(id);

    expect((await repo.destination(id))!.generation).toBe(generation + 1);
    const verified = live.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM backup_entries
          WHERE destination_id=? AND verified_sequence=sequence AND last_error IS NULL`,
      )
      .all(id);
    expect(verified[0]!.n).toBe(2);
  } finally {
    live.close();
  }
});
