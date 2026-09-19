/**
 * GET /api/libraries/:id/backup/state — the device reconciliation feed.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for each test (#3787). Each test gets its own, so there is nothing to clean
 * up between them and nothing for a sibling suite to inherit.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { ObjectId } from 'mongodb';
import { authedHandle } from './helpers/authed-handle.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { seedBackupAsset, seedLibrary } from './helpers/sqlite-fixtures.ts';
import { invalidateLibraryRoots } from '../src/indexer/libraries.cache.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const deviceId = 'test-device-state';

let live: LiveTestDatabase;
let libId: ObjectId;
let tmpLib: string;

beforeEach(async () => {
  tmpLib = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-state-test-'));
  live = await createLiveTestDatabase();
  libId = seedLibrary(live.db, { path: tmpLib, label: 'state-test' });
  invalidateLibraryRoots();
  // `path: ''` puts each file at the library root, so `rel_path` is the bare
  // filename — which is what the route composes from the asset's location.
  seedBackupAsset(live.db, {
    mapleId: 'hash-a',
    locations: [{ libraryId: libId, relPath: 'a.heic' }],
    links: [{ deviceId, phassetLocalId: 'P1', firstSeen: new Date('2026-05-10T00:00:00Z') }],
  });
  seedBackupAsset(live.db, {
    mapleId: 'hash-b',
    locations: [{ libraryId: libId, relPath: 'b.heic' }],
    links: [{ deviceId, phassetLocalId: 'P2', firstSeen: new Date('2026-05-11T01:00:00Z') }],
  });
});

afterEach(async () => {
  live.close();
  invalidateLibraryRoots();
  await fs.rm(tmpLib, { recursive: true, force: true });
});

describe('GET /api/libraries/:id/backup/state', () => {
  test('returns only assets first-seen since `since` for the given device', async () => {
    const since = '2026-05-10T12:00:00Z';
    const url = `http://localhost/api/libraries/${libId.toHexString()}/backup/state?device_id=${deviceId}&since=${encodeURIComponent(since)}`;
    const res = await authedHandle(new Request(url));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.assets.map((a: any) => a.phasset_local_id).sort();
    expect(ids).toEqual(['P2']);
    expect(body.assets[0].maple_id).toBe('hash-b');
  });

  test('returns all device assets when `since` is omitted', async () => {
    const url = `http://localhost/api/libraries/${libId.toHexString()}/backup/state?device_id=${deviceId}`;
    const res = await authedHandle(new Request(url));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.assets.map((a: any) => a.phasset_local_id).sort();
    expect(ids).toEqual(['P1', 'P2']);
  });

  test('400 when device_id missing', async () => {
    const url = `http://localhost/api/libraries/${libId.toHexString()}/backup/state`;
    const res = await authedHandle(new Request(url));
    expect(res.status).toBe(400);
  });

  test('400 on invalid library id', async () => {
    const res = await authedHandle(
      new Request(
        `http://localhost/api/libraries/not-an-objectid/backup/state?device_id=${deviceId}`,
      ),
    );
    expect(res.status).toBe(400);
  });

  test('rel_path is library-relative, not an absolute path', async () => {
    const url = `http://localhost/api/libraries/${libId.toHexString()}/backup/state?device_id=${deviceId}`;
    const res = await authedHandle(new Request(url));
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const asset of body.assets) {
      // Must not start with '/' or contain an absolute-path prefix like '/tmp/'
      expect(asset.rel_path.startsWith('/')).toBe(false);
      expect(asset.rel_path).not.toContain('/tmp/');
      // Must be a bare relative path — no '..' escaping the root
      expect(asset.rel_path.startsWith('..')).toBe(false);
    }
  });

  test('an asset whose only location in this library is trashed is left out', async () => {
    seedBackupAsset(live.db, {
      mapleId: 'hash-c',
      locations: [{ libraryId: libId, relPath: 'c.heic', deletedAt: '2026-05-12T00:00:00Z' }],
      links: [{ deviceId, phassetLocalId: 'P3', firstSeen: new Date('2026-05-11T02:00:00Z') }],
    });
    const url = `http://localhost/api/libraries/${libId.toHexString()}/backup/state?device_id=${deviceId}`;
    const res = await authedHandle(new Request(url));
    const body = await res.json();
    expect(body.assets.map((a: any) => a.phasset_local_id).sort()).toEqual(['P1', 'P2']);
  });
});
