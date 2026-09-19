/**
 * cf-thumb-sync stage handler tests. Real SQLite (one in-memory database per
 * test, installed as the process-wide handle so the handler's own
 * `loadCloudflareConfig` and library-root lookups reach it) and a real tmp
 * filesystem. `fetch` is stubbed globally rather than mocking `r2-client.ts`,
 * the same technique used throughout `src/cloudflare/`.
 *
 * The success assertion is on the new shape: a handler returns the statements
 * the runner commits alongside its stage row, not a map of document fields it
 * folds into a `$set` (#3787).
 */

import { describe, expect, it, beforeAll, afterAll, afterEach, beforeEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId } from '../../db/object-id.ts';
import cfThumbSyncStage from './cf-thumb-sync.ts';
import { resolveThumbPath } from '../../fs/xmp.ts';
import { patchAppSettings } from '../../db/sqlite/repos/app-settings.repo.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';

const CF_CONFIG = {
  enabled: true,
  account_id: 'acct123',
  bucket: 'maple-thumbs',
  access_key_id: 'AKIAEXAMPLE',
  secret_access_key: 'secretexample',
};

describe('cf-thumb-sync stage', () => {
  let live: LiveTestDatabase;
  let dir: string;
  let libId: ObjectId;
  const realFetch = globalThis.fetch;

  function stubFetch(status: number): void {
    globalThis.fetch = (async () => new Response('', { status })) as unknown as typeof fetch;
  }

  async function makeAsset(
    filename: string,
    mapleId: string,
    opts?: { noThumb?: boolean; hidden?: boolean },
  ) {
    const relDir = 'vacation';
    if (!opts?.noThumb) {
      // Stage the fixture at the PATH-KEYED name the stage resolves — keyed on
      // the basename, not `maple_id` (#2220 follow-up).
      const thumbPath = resolveThumbPath(path.join(dir, relDir, filename));
      await mkdir(path.dirname(thumbPath), { recursive: true });
      await writeFile(thumbPath, Buffer.from('fake-avif-bytes'));
    }
    return {
      _id: new ObjectId(),
      fileinfo: [{ path: relDir, filename, library_id: libId, deleted_at: null }],
      maple_id: mapleId,
      hidden: opts?.hidden ?? false,
      cf_thumb_synced_at: null as string | null,
    };
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cf-thumb-sync-'));
  });

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    libId = new ObjectId(insertFolder(live.db, { path: dir, slug: 'cf-thumb-sync-lib' }));
    invalidateLibraryRoots();
    await patchAppSettings('cloudflare', { config: CF_CONFIG });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    invalidateLibraryRoots();
    live.close();
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uploads the thumbnail and returns the statement stamping cf_thumb_synced_at', async () => {
    stubFetch(200);
    const asset = await makeAsset('a.jpg', 'a'.repeat(32));

    const result = await cfThumbSyncStage.handler(asset as never, {} as never);
    expect(result).toHaveProperty('patch');
    const [statement, ...rest] = (result as { patch: { sql: string; params: unknown[] }[] }).patch;
    expect(rest).toHaveLength(0);
    expect(statement!.sql).toContain('cf_thumb_synced_at');
    // The stamp is a timestamp and it addresses this asset — the two things the
    // runner's transaction will actually write.
    expect(typeof statement!.params[0]).toBe('string');
    expect(statement!.params[1]).toBe(asset._id.toHexString());
  });

  it('skips a hidden asset without touching R2', async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const asset = await makeAsset('hidden.jpg', 'h'.repeat(32), { hidden: true });

    const result = await cfThumbSyncStage.handler(asset as never, {} as never);
    expect(result).toEqual({ skip: 'hidden' });
    expect(fetchCalled).toBe(false);
  });

  it('cleans up R2 if a hidden asset is marked as synced', async () => {
    let fetchCalled = false;
    let fetchMethod = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalled = true;
      fetchMethod = input instanceof Request ? input.method : (init?.method ?? 'GET');
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const asset = await makeAsset('hidden-synced.jpg', 's'.repeat(32), { hidden: true });
    asset.cf_thumb_synced_at = '2026-01-01T00:00:00.000Z';

    const result = await cfThumbSyncStage.handler(asset as never, {} as never);
    expect(result).toEqual({ skip: 'hidden' });
    expect(fetchCalled).toBe(true);
    expect(fetchMethod).toBe('DELETE');
  });

  it('skips terminally (no-thumb) when the thumbnail has not been generated yet', async () => {
    stubFetch(200);
    const asset = await makeAsset('nothumb.jpg', 'b'.repeat(32), { noThumb: true });

    const result = await cfThumbSyncStage.handler(asset as never, {} as never);
    expect(result).toEqual({ skip: 'no-thumb' });
  });

  it('throws when Cloudflare config is not complete/enabled, for the runner to retry/dead-letter', async () => {
    await patchAppSettings('cloudflare', { config: { ...CF_CONFIG, enabled: false } });
    stubFetch(200);
    const asset = await makeAsset('c.jpg', 'c'.repeat(32));

    await expect(cfThumbSyncStage.handler(asset as never, {} as never)).rejects.toThrow(
      /not complete\/enabled/,
    );
  });

  it('propagates an R2 upload failure by throwing (retry/backoff owned by the runner)', async () => {
    stubFetch(500);
    const asset = await makeAsset('d.jpg', 'd'.repeat(32));

    await expect(cfThumbSyncStage.handler(asset as never, {} as never)).rejects.toThrow(/500/);
  });
});
