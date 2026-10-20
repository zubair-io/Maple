/**
 * Entries parked on a Google connection failure re-arm on their own once the
 * connection is healthy again, without a transfer having to succeed first or
 * the server being restarted (#5038). Real SQLite rows; the Drive provider is
 * the in-memory test provider.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from '../fs/mirrored.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { BackupRepository } from './repository.ts';
import { BackupEngine } from './engine.ts';
import { GoogleDriveError } from './google/client.ts';
import { createTestProvider } from './test-provider.test-helpers.ts';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-backup-rearm-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function parkedDestination(live: Awaited<ReturnType<typeof createLiveTestDatabase>>) {
  const libraryId = insertFolder(live.db, { path: root });
  const repo = new BackupRepository(live.handle);
  const created = await repo.createDestination({
    libraryId,
    kind: 'google-drive',
    name: 'Drive',
    path: null,
  });
  await repo.updateDestination(created.id, { enabled: true });
  const destination = (await repo.destination(created.id))!;
  const assetId = insertAsset(live.db);
  insertLocation(live.db, { assetId, libraryId, filename: 'parked.dng', path: '' });
  await fs.writeFile(path.join(root, 'parked.dng'), 'original photo bytes');
  const entry = await repo.ensureEntry(destination.id, assetId, 0, 'parked.dng');
  await repo.db.write(
    `UPDATE backup_entries SET last_error='Google is unreachable; retry shortly.',
       error_kind='connection', attempts=9, retry_at=? WHERE id=?`,
    [Date.now() + 3_600_000, entry.id],
  );
  live.db
    .query(
      `UPDATE stage_state SET version=0, attempts=5, dead=1, next_attempt_at=?
       WHERE stage='cloud-backup' AND asset_id=?`,
    )
    .run(new Date(Date.now() + 3_600_000).toISOString(), assetId);
  const provider = createTestProvider();
  return { repo, destination, assetId, provider };
}

test('a healthy probe during maintenance re-arms entries parked on connection failures', async () => {
  using live = await createLiveTestDatabase();
  const { repo, destination, assetId, provider } = await parkedDestination(live);
  const engine = new BackupEngine(async () => provider, repo);

  await engine.rearmParkedConnections();

  expect((await repo.entries(destination.id, assetId))[0]).toMatchObject({
    last_error: null,
    error_kind: null,
    attempts: 0,
    retry_at: 0,
  });
});

test('a destination that is still unreachable keeps its entries parked', async () => {
  using live = await createLiveTestDatabase();
  const { repo, destination, assetId, provider } = await parkedDestination(live);
  provider.probe = () => Promise.reject(new GoogleDriveError(0, null));
  const engine = new BackupEngine(async () => provider, repo);

  await engine.rearmParkedConnections();

  expect((await repo.entries(destination.id, assetId))[0]).toMatchObject({
    error_kind: 'connection',
    attempts: 9,
  });
});

test('a destination that stays healthy re-arms once, so failing entries keep their backoff', async () => {
  using live = await createLiveTestDatabase();
  const { repo, destination, assetId, provider } = await parkedDestination(live);
  const engine = new BackupEngine(async () => provider, repo);
  await engine.rearmParkedConnections();
  const [entry] = await repo.entries(destination.id, assetId);
  await repo.db.write(
    `UPDATE backup_entries SET last_error='quota', error_kind='connection', attempts=9, retry_at=?
     WHERE id=?`,
    [Date.now() + 3_600_000, entry!.id],
  );

  await engine.rearmParkedConnections();

  expect((await repo.entries(destination.id, assetId))[0]).toMatchObject({ attempts: 9 });
});

test('a destination that recovers from an outage re-arms its parked entries', async () => {
  using live = await createLiveTestDatabase();
  const { repo, destination, assetId, provider } = await parkedDestination(live);
  const healthyProbe = provider.probe.bind(provider);
  provider.probe = () => Promise.reject(new GoogleDriveError(0, null));
  const engine = new BackupEngine(async () => provider, repo);
  await engine.rearmParkedConnections();
  provider.probe = healthyProbe;

  await engine.rearmParkedConnections();

  expect((await repo.entries(destination.id, assetId))[0]).toMatchObject({ attempts: 0 });
});

async function failOneTransfer(
  engine: BackupEngine,
  provider: ReturnType<typeof createTestProvider>,
  assetId: string,
  error: Error,
) {
  const healthyProbe = provider.probe.bind(provider);
  provider.probe = () => Promise.reject(error);
  expect(await engine.backupAsset(assetId)).toBe(false);
  provider.probe = healthyProbe;
}

test('an outage after a re-arm parks entries that the next recovery re-arms again', async () => {
  using live = await createLiveTestDatabase();
  const { repo, destination, assetId, provider } = await parkedDestination(live);
  const engine = new BackupEngine(async () => provider, repo);
  await engine.rearmParkedConnections();
  await failOneTransfer(engine, provider, assetId, new GoogleDriveError(0, null));
  expect((await repo.entries(destination.id, assetId))[0]?.error_kind).toBe('connection');

  await engine.rearmParkedConnections();

  expect((await repo.entries(destination.id, assetId))[0]).toMatchObject({
    error_kind: null,
    attempts: 0,
  });
});

test('a refused request on a healthy destination keeps its backoff', async () => {
  using live = await createLiveTestDatabase();
  const { repo, destination, assetId, provider } = await parkedDestination(live);
  const engine = new BackupEngine(async () => provider, repo);
  await engine.rearmParkedConnections();
  await failOneTransfer(engine, provider, assetId, new GoogleDriveError(403, null));

  await engine.rearmParkedConnections();

  expect((await repo.entries(destination.id, assetId))[0]).toMatchObject({
    error_kind: 'connection',
    attempts: 1,
  });
});
