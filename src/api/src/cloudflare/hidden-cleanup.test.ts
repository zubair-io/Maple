/**
 * hidden-cleanup integration tests. Real SQLite (one in-memory database per
 * test, installed as the process-wide handle so the module's own
 * `clearCfThumbSyncedAt` and `loadCloudflareConfig` calls reach it), `fetch`
 * stubbed for the R2 call — see `r2-client.test.ts`'s header comment for why.
 *
 * The library-slug map is seeded through `setLibraryBySlugForTests` rather than
 * from the database, because this suite is about the cleanup's own behaviour,
 * not about how the slug map is populated.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ObjectId } from '../db/object-id.ts';
import { cleanupR2ThumbForHiddenAsset, cleanupR2ThumbsForHiddenAssets } from './hidden-cleanup.ts';
import { patchAppSettings } from '../db/sqlite/repos/app-settings.repo.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots, setLibraryBySlugForTests } from '../indexer/libraries.cache.ts';
import { newObjectIdHex } from '../db/object-id.ts';

const LIBRARY_SLUG = 'hidden-cleanup-lib';
const LIBRARY_ROOT = '/tmp/hidden-cleanup-lib';
const SYNCED_AT = '2026-01-01T00:00:00.000Z';

const CF_CONFIG = {
  enabled: true,
  account_id: 'acct123',
  bucket: 'maple-thumbs',
  access_key_id: 'AKIAEXAMPLE',
  secret_access_key: 'secretexample',
};

const realFetch = globalThis.fetch;
let calls: Array<{ method: string; url: string }>;

function stubFetch(status: number): void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ method, url });
    return new Response('', { status });
  }) as typeof fetch;
}

let live: LiveTestDatabase;
let libId: ObjectId;

/**
 * An asset the cleanup can act on: the in-memory projection the callers hand
 * it, plus the row its `cf_thumb_synced_at` write needs to find.
 */
function makeAsset(overrides: Partial<{ synced: boolean; noFileinfo: boolean }> = {}) {
  const hex = newObjectIdHex();
  insertAsset(live.db, { id: hex });
  const syncedAt = overrides.synced === false ? null : SYNCED_AT;
  run(live.db, `UPDATE assets SET cf_thumb_synced_at = ? WHERE id = ?`, syncedAt, hex);
  return {
    _id: new ObjectId(hex),
    fileinfo: overrides.noFileinfo
      ? []
      : [{ path: 'vacation', filename: 'a.jpg', library_id: libId, deleted_at: null }],
    cf_thumb_synced_at: syncedAt,
  };
}

function storedSyncedAt(id: ObjectId): string | null | undefined {
  const row = live.db
    .query(`SELECT cf_thumb_synced_at AS at FROM assets WHERE id = ?`)
    .get(id.toHexString()) as { at: string | null } | null;
  return row?.at;
}

describe('cleanupR2ThumbForHiddenAsset / cleanupR2ThumbsForHiddenAssets', () => {
  beforeEach(async () => {
    live = await createLiveTestDatabase();
    libId = new ObjectId();
    invalidateLibraryRoots();
    setLibraryBySlugForTests(LIBRARY_SLUG, {
      libraryId: libId,
      root: LIBRARY_ROOT,
      label: LIBRARY_SLUG,
    });
    await patchAppSettings('cloudflare', { config: CF_CONFIG });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    invalidateLibraryRoots();
    live.close();
  });

  it('deletes the R2 object and clears cf_thumb_synced_at for a previously-synced asset', async () => {
    stubFetch(200);
    const asset = makeAsset();

    await cleanupR2ThumbForHiddenAsset(asset);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toContain(`thumbs/${LIBRARY_SLUG}/vacation/a.jpg`);
    expect(storedSyncedAt(asset._id)).toBeNull();
  });

  it('still attempts the R2 delete when the in-memory snapshot says never-synced (stale-read guard)', async () => {
    // A 404 is exactly what R2 would return for a genuinely-never-uploaded
    // key — deleteThumbFromR2 treats that as success. This exercises the
    // fix for the race where `asset.cf_thumb_synced_at` reflects a stale
    // pre-upload snapshot even though the real row (or R2 itself) has
    // since moved on; skipping on that stale read would leak a thumbnail
    // that actually did get uploaded moments after this asset was claimed.
    stubFetch(404);
    const asset = makeAsset({ synced: false });

    await cleanupR2ThumbForHiddenAsset(asset);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('DELETE');
    expect(storedSyncedAt(asset._id)).toBeNull();
  });

  it('is a no-op when Cloudflare credentials are not saved, even with enabled: true stale in memory', async () => {
    run(live.db, `DELETE FROM app_settings`);
    stubFetch(200);
    const asset = makeAsset();

    await cleanupR2ThumbForHiddenAsset(asset);

    expect(calls).toHaveLength(0);
    expect(storedSyncedAt(asset._id)).toBe(SYNCED_AT);
  });

  it('runs even when Cloudflare uploads are currently disabled (enabled: false) — deletion is not gated on the toggle', async () => {
    await patchAppSettings('cloudflare', { config: { ...CF_CONFIG, enabled: false } });
    stubFetch(200);
    const asset = makeAsset();

    await cleanupR2ThumbForHiddenAsset(asset);

    expect(calls).toHaveLength(1);
  });

  it('never throws when the R2 delete fails, and leaves cf_thumb_synced_at untouched', async () => {
    stubFetch(500);
    const asset = makeAsset();

    await expect(cleanupR2ThumbForHiddenAsset(asset)).resolves.toBeUndefined();

    expect(storedSyncedAt(asset._id)).toBe(SYNCED_AT);
  });

  it('skips an asset with no resolvable fileinfo without throwing', async () => {
    stubFetch(200);
    const asset = makeAsset({ noFileinfo: true });

    await cleanupR2ThumbForHiddenAsset(asset);

    expect(calls).toHaveLength(0);
  });

  it('bulk variant fans out deletes for every eligible asset in one credential resolve', async () => {
    stubFetch(200);
    const a = makeAsset();
    const b = makeAsset();
    // Attempted unconditionally too (see the stale-read test above) —
    // still counts toward the fan-out even though never actually synced.
    const notSynced = makeAsset({ synced: false });

    await cleanupR2ThumbsForHiddenAssets([a, b, notSynced]);

    expect(calls).toHaveLength(3);
    expect(storedSyncedAt(a._id)).toBeNull();
    expect(storedSyncedAt(b._id)).toBeNull();
    expect(storedSyncedAt(notSynced._id)).toBeNull();
  });

  it('bulk variant is a no-op for an empty list', async () => {
    stubFetch(200);
    await cleanupR2ThumbsForHiddenAssets([]);
    expect(calls).toHaveLength(0);
  });
});
