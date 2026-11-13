/**
 * A worker shutdown mid-transfer is not a backup failure (#5395): the entry
 * keeps no error, spends no retry, and the next claim resumes it. Real SQLite,
 * real files and the Google Drive provider against a fake Drive transport.
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
import { GoogleDriveProvider } from './google/provider.ts';
import { googleStore } from './google/google-store.test-helpers.ts';
import type { GoogleFetch } from './google/oauth.ts';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-backup-shutdown-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Hangs the first media upload until its request is aborted, as fetch does. */
function stallFirstUpload(store: ReturnType<typeof googleStore>, onStall: () => void): GoogleFetch {
  let stalled = false;
  return async (url, init) => {
    const uploading =
      init?.method === 'PUT' &&
      new Headers(init.headers).get('content-range')?.startsWith('bytes 0-');
    if (!uploading || stalled) return store.transport(url, init);
    stalled = true;
    const signal = init!.signal!;
    return new Promise<Response>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
      onStall();
    });
  };
}

async function enabledDestination(live: Awaited<ReturnType<typeof createLiveTestDatabase>>) {
  const libraryId = insertFolder(live.db, { path: root });
  const repo = new BackupRepository(live.handle);
  const created = await repo.createDestination({
    libraryId,
    kind: 'google-drive',
    name: 'Drive',
    path: null,
  });
  await repo.updateDestination(created.id, { enabled: true });
  await repo.db.write(`UPDATE backup_destinations SET root_id='maple-root' WHERE id=?`, [
    created.id,
  ]);
  const assetId = insertAsset(live.db);
  insertLocation(live.db, {
    assetId,
    libraryId,
    filename: 'IMG_0042.dng',
    path: '',
  });
  await fs.writeFile(path.join(root, 'IMG_0042.dng'), 'original photo bytes');
  return { repo, destinationId: created.id, assetId };
}

test('a shutdown during an upload leaves the entry unblocked and resumable', async () => {
  using live = await createLiveTestDatabase();
  const { repo, destinationId, assetId } = await enabledDestination(live);
  const store = googleStore();
  const shutdown = new AbortController();
  const transport = stallFirstUpload(store, () => shutdown.abort());
  const engine = new BackupEngine(
    async (destination) =>
      new GoogleDriveProvider(destination.rootId!, async () => 'token', transport),
    repo,
  );

  expect(await engine.backupAsset(assetId, shutdown.signal)).toBe(false);

  expect((await repo.entries(destinationId, assetId))[0]).toMatchObject({
    last_error: null,
    error_kind: null,
    attempts: 0,
    retry_at: 0,
    lease_owner: null,
    lease_until: 0,
  });

  expect(await engine.backupAsset(assetId)).toBe(true);
  const [entry] = await repo.entries(destinationId, assetId);
  expect(entry?.verified_sequence).toBe(entry?.sequence);
  const uploaded = [...store.files.values()].find((file) => file.name === 'IMG_0042.dng');
  expect(new TextDecoder().decode(uploaded?.bytes)).toBe('original photo bytes');
});

test('an interrupted upload while the worker keeps running still records its failure', async () => {
  using live = await createLiveTestDatabase();
  const { repo, destinationId, assetId } = await enabledDestination(live);
  const store = googleStore();
  store.failChunk();
  const engine = new BackupEngine(
    async (destination) =>
      new GoogleDriveProvider(destination.rootId!, async () => 'token', store.transport),
    repo,
  );

  expect(await engine.backupAsset(assetId, new AbortController().signal)).toBe(false);

  expect((await repo.entries(destinationId, assetId))[0]).toMatchObject({
    last_error: 'Google Drive request failed (0).',
    error_kind: 'connection',
    attempts: 1,
    lease_owner: null,
  });
});
