/**
 * A long R2 or DNS outage (#5589) must not dead-letter `cf-thumb-sync` rows:
 * the failure says nothing about the thumbnail. Drives the real runner
 * (`runOnce`) against real SQLite across more ticks than `maxAttempts`, then
 * brings R2 back and expects every row to upload.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import cfThumbSyncStage from './cf-thumb-sync.ts';
import { THUMB_TARGET_VERSION } from '../derivative-versions.ts';
import { patchAppSettings } from '../../db/repos/app-settings.repo.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { mkdir, rm, writeFile } from '../../fs/mirrored.ts';
import { resolveThumbPath } from '../../fs/xmp.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { runOnce, type StageConfig } from '../run-stage.ts';

const MAX_ATTEMPTS = 5;
const TICKS_PAST_THE_LIMIT = MAX_ATTEMPTS + 3;
const ASSET_COUNT = 3;

const CF_CONFIG = {
  enabled: true,
  account_id: 'acct123',
  bucket: 'maple-thumbs',
  access_key_id: 'AKIAEXAMPLE',
  secret_access_key: 'secretexample',
};

const dnsFailure = () =>
  Object.assign(new Error('getaddrinfo EAI_AGAIN acct123.r2.cloudflarestorage.com'), {
    code: 'EAI_AGAIN',
  });
const connectRefused = () =>
  Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), {
    code: 'ConnectionRefused',
  });
const requestTimeout = () => new DOMException('The operation timed out.', 'TimeoutError');

type Respond = () => Response | Promise<never>;
const OUTAGES: readonly (readonly [string, Respond])[] = [
  ['DNS failure', () => Promise.reject(dnsFailure())],
  ['connection refused', () => Promise.reject(connectRefused())],
  ['request timeout', () => Promise.reject(requestTimeout())],
  ['R2 throttling (429)', () => new Response('slow down', { status: 429 })],
  ['R2 server error (503)', () => new Response('unavailable', { status: 503 })],
];

let live: LiveTestDatabase;
let dir = '';
let assetIds: string[] = [];
const realFetch = globalThis.fetch;

function stubFetch(respond: Respond): void {
  globalThis.fetch = (async () => respond()) as unknown as typeof fetch;
}

function stageRow(assetId: string) {
  return live.db
    .query(
      `SELECT version, attempts, dead, last_error FROM stage_state
        WHERE asset_id = ? AND stage = 'cf-thumb-sync'`,
    )
    .get(assetId) as { version: number; attempts: number; dead: number; last_error: string | null };
}

function syncedAt(assetId: string): string | null {
  const row = live.db.query(`SELECT cf_thumb_synced_at FROM assets WHERE id = ?`).get(assetId) as {
    cf_thumb_synced_at: string | null;
  };
  return row.cf_thumb_synced_at;
}

async function tickAfterBackoff(): Promise<void> {
  run(live.db, `UPDATE stage_state SET next_attempt_at = NULL WHERE stage = 'cf-thumb-sync'`);
  await runOnce(cfThumbSyncStage as unknown as StageConfig, {
    concurrency: 2,
    maxAttempts: MAX_ATTEMPTS,
    paused: false,
    last_seen_target_version: cfThumbSyncStage.targetVersion,
  });
}

beforeEach(async () => {
  live = await createLiveTestDatabase();
  dir = path.join(os.tmpdir(), `cf-thumb-outage-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const libraryId = insertFolder(live.db, { path: dir, slug: 'outage-lib' });
  invalidateLibraryRoots();
  await patchAppSettings('cloudflare', { config: CF_CONFIG });
  assetIds = [];
  for (let i = 0; i < ASSET_COUNT; i++) {
    const filename = `photo-${i}.jpg`;
    const assetId = insertAsset(live.db);
    insertLocation(live.db, { assetId, libraryId, path: 'trip', filename });
    const thumbPath = resolveThumbPath(path.join(dir, 'trip', filename));
    await mkdir(path.dirname(thumbPath), { recursive: true });
    await writeFile(thumbPath, Buffer.from('fake-avif-bytes'));
    run(
      live.db,
      `INSERT INTO stage_state (asset_id, stage, version) VALUES (?, 'thumb', ?)`,
      assetId,
      THUMB_TARGET_VERSION,
    );
    run(
      live.db,
      `INSERT INTO stage_state (asset_id, stage, version) VALUES (?, 'cf-thumb-sync', 0)`,
      assetId,
    );
    assetIds.push(assetId);
  }
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  invalidateLibraryRoots();
  live.close();
  await rm(dir, { recursive: true, force: true });
});

describe('cf-thumb-sync through a sustained R2 outage', () => {
  it.each(OUTAGES)('%s: no row dead-letters, all upload once R2 is back', async (_name, outage) => {
    stubFetch(outage);
    for (let tick = 0; tick < TICKS_PAST_THE_LIMIT; tick++) await tickAfterBackoff();

    for (const assetId of assetIds) {
      expect(stageRow(assetId)).toMatchObject({ version: 0, dead: 0, attempts: 0 });
      expect(stageRow(assetId).last_error).toBeTruthy();
      expect(syncedAt(assetId)).toBeNull();
    }

    stubFetch(() => new Response('', { status: 200 }));
    await tickAfterBackoff();

    for (const assetId of assetIds) {
      expect(stageRow(assetId)).toMatchObject({ version: cfThumbSyncStage.targetVersion, dead: 0 });
      expect(syncedAt(assetId)).not.toBeNull();
    }
  });

  it('still dead-letters a permanent answer from R2 (rejected credentials)', async () => {
    stubFetch(() => new Response('SignatureDoesNotMatch', { status: 403 }));
    for (let tick = 0; tick < TICKS_PAST_THE_LIMIT; tick++) await tickAfterBackoff();

    for (const assetId of assetIds) {
      expect(stageRow(assetId)).toMatchObject({ version: 0, dead: 1 });
    }
  });
});
