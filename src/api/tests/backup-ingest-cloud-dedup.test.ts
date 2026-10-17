/**
 * POST /api/libraries/:id/backup/ingest — cloud-id persistence and advanced
 * dedup.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for each test (#3787), with the library rooted at a per-test tmp directory.
 * The happy paths live in `backup-ingest.test.ts`; error/edge cases in
 * `backup-ingest-errors.test.ts`. Split to keep each file under the file-size
 * budget (#114).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { authedHandle } from './helpers/authed-handle.ts';
import { deriveId } from '../src/indexer/id.ts';
import {
  findAssetIdByMapleId,
  findAssetsByMapleId,
  findPhassetLinksByLocalId,
  readPhassetLinks,
  seedBackupAsset,
} from './helpers/sqlite-fixtures.ts';
import { makeIngestRequest, setupBackupIngestSuite } from './backup-ingest-helpers.ts';

const deviceId = 'test-device-ingest-cloud';

const suite = setupBackupIngestSuite();
beforeEach(suite.setup);
afterEach(suite.teardown);

const ingest = makeIngestRequest(suite.handle);

/** Every file under `dir`, recursively, as absolute paths. */
async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? await walk(full) : [full];
    }),
  );
  return nested.flat();
}

describe('POST /api/libraries/:id/backup/ingest — cloud-id + advanced dedup', () => {
  test('backup upload with spec-form maple_id matching pre-seeded asset → dedup, no second file', async () => {
    // End-to-end dedup proof for the device-side spec-form maple_id fix: an
    // indexer-style asset row exists on disk + in the database, and the device
    // backs up the same content with the matching spec-form id. The server must
    // short-circuit on the content id and not write a second copy.

    // Simulate "indexer scanned this file" — write the file to the library
    // folder directly, derive a spec-form id from its head, seed the asset row
    // with that id.
    const indexerRelPath = 'indexed/IMG_INDEXED.HEIC';
    const indexerAbsPath = path.join(suite.handle.tmpLib, indexerRelPath);
    await fs.mkdir(path.dirname(indexerAbsPath), { recursive: true });
    const sharedBytes = Buffer.alloc(1024, 0xab);
    await fs.writeFile(indexerAbsPath, sharedBytes);

    const capturedAt = '2024-09-01T10:00:00.000Z';
    const id = deriveId(new Uint8Array(sharedBytes), capturedAt, null, null);
    // Sanity: id is the 32-char spec form (tag 0x01 primary).
    expect(id.hex.length).toBe(32);
    expect(id.kind).toBe('primary');

    // The persisted location is a row in `asset_locations`; the backup-ingest
    // route resolves the dedup target's path from it.
    seedBackupAsset(suite.handle.db, {
      mapleId: id.hex,
      size: sharedBytes.byteLength,
      locations: [{ libraryId: suite.handle.libId, relPath: indexerRelPath }],
    });

    // Now the device sends a backup with the same content + same spec-form id.
    const devicePhid = 'ABC/L0/SPEC-FORM';
    const deviceForId = 'device-spec-form';
    const res = await authedHandle(
      ingest(sharedBytes, {
        'X-Maple-Device-Id': deviceForId,
        'X-Maple-Phasset-Id': devicePhid,
        'X-Maple-Capture-Date': capturedAt,
        'X-Maple-Filename': 'IMG_INDEXED.HEIC',
        'X-Maple-Total-Bytes': String(sharedBytes.byteLength),
        'X-Maple-Maple-Id': id.hex,
        'Content-Range': `bytes 0-${sharedBytes.byteLength - 1}/${sharedBytes.byteLength}`,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maple_id).toBe(id.hex);
    // Response references the pre-seeded asset's path — proves the server
    // resolved to the existing row, not a fresh upload destination.
    expect(body.target_rel_path).toBe(indexerRelPath);

    // Exactly one asset row; the device link was recorded against it.
    const rows = findAssetsByMapleId(suite.handle.db, id.hex);
    expect(rows).toHaveLength(1);
    const assetId = findAssetIdByMapleId(suite.handle.db, id.hex);
    expect(assetId).not.toBeNull();
    const links = readPhassetLinks(suite.handle.db, assetId!);
    expect(links).toHaveLength(1);
    expect(links[0].device_id).toBe(deviceForId);
    expect(links[0].phasset_local_id).toBe(devicePhid);

    // Only the indexer's file exists on disk under the library folder —
    // no second copy was written under the device's would-be target path.
    // The "phid-routing" target path would have been derived from
    // capture_date + filename → e.g. `2024/2024/09-01/IMG_INDEXED.HEIC` —
    // walk the folder tree and assert exactly one IMG_INDEXED.HEIC exists.
    const allFiles = await walk(suite.handle.tmpLib);
    const sharedNameMatches = allFiles.filter((p) => p.endsWith('IMG_INDEXED.HEIC'));
    expect(sharedNameMatches).toHaveLength(1);
    expect(sharedNameMatches[0]).toBe(indexerAbsPath);
  });

  test('cross-device: second device gets 423 while peer is actively uploading', async () => {
    const sharedCloudId = 'icloud-BUSY-PHOTO';
    // Phone starts a multi-chunk upload but doesn't finish yet.
    const phoneR1 = await authedHandle(
      ingest(Buffer.alloc(128, 9), {
        'X-Maple-Device-Id': 'phone-busy',
        'X-Maple-Phasset-Id': 'phone-local-busy',
        'X-Maple-PHAsset-Cloud-Id': sharedCloudId,
        'X-Maple-Capture-Date': '2024-10-01T08:00:00Z',
        'X-Maple-Filename': 'IMG_BUSY.HEIC',
        'X-Maple-Total-Bytes': '256',
        'Content-Range': 'bytes 0-127/256',
      }),
    );
    expect(phoneR1.status).toBe(202);

    // Desktop tries the same iCloud asset concurrently — should be told to back off.
    const desktopR = await authedHandle(
      ingest(Buffer.alloc(128, 10), {
        'X-Maple-Device-Id': 'desktop-busy',
        'X-Maple-Phasset-Id': 'desktop-local-busy',
        'X-Maple-PHAsset-Cloud-Id': sharedCloudId,
        'X-Maple-Capture-Date': '2024-10-01T08:00:00Z',
        'X-Maple-Filename': 'IMG_BUSY.HEIC',
        'X-Maple-Total-Bytes': '256',
        'Content-Range': 'bytes 0-127/256',
      }),
    );
    expect(desktopR.status).toBe(423);
    const body = await desktopR.json();
    expect(body.retry_after_seconds).toBeGreaterThan(0);
  });

  test('X-Maple-PHAsset-Cloud-Id is persisted onto the device link', async () => {
    const phidCloud = 'ABC/L0/CLOUD1';
    const cloudId = 'icloud-XYZ-stable-across-devices';
    const res = await authedHandle(
      ingest(Buffer.alloc(64, 13), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phidCloud,
        'X-Maple-PHAsset-Cloud-Id': cloudId,
        'X-Maple-Capture-Date': '2024-08-01T08:00:00Z',
        'X-Maple-Filename': 'IMG_CLOUD.HEIC',
        'X-Maple-Total-Bytes': '64',
        'X-Maple-Maple-Id': '02080b93a65e5abdcd6667d42963d570',
        'Content-Range': 'bytes 0-63/64',
      }),
    );
    expect(res.status).toBe(200);

    const links = findPhassetLinksByLocalId(suite.handle.db, phidCloud);
    expect(links).toHaveLength(1);
    expect(links[0].phasset_cloud_id).toBe(cloudId);
  });

  test('absent X-Maple-PHAsset-Cloud-Id leaves phasset_cloud_id unset', async () => {
    const phidNoCloud = 'ABC/L0/NOCLOUD';
    const res = await authedHandle(
      ingest(Buffer.alloc(64, 14), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phidNoCloud,
        // No X-Maple-PHAsset-Cloud-Id header — simulates iCloud Photos off.
        'X-Maple-Capture-Date': '2024-08-01T08:00:00Z',
        'X-Maple-Filename': 'IMG_NOCLOUD.HEIC',
        'X-Maple-Total-Bytes': '64',
        'X-Maple-Maple-Id': '02cbd737df5df6dd7856fa70df9ad0d1',
        'Content-Range': 'bytes 0-63/64',
      }),
    );
    expect(res.status).toBe(200);

    const links = findPhassetLinksByLocalId(suite.handle.db, phidNoCloud);
    expect(links).toHaveLength(1);
    // The absent Mongo field is a NULL column here.
    expect(links[0].phasset_cloud_id).toBeNull();
  });

  test('second device with same maple_id adds a link row carrying its cloud id', async () => {
    const sharedMapleId = '02f0cdd420e020da4a3fcd60af3c35d3';
    const deviceA = 'device-A-cloud';
    const deviceB = 'device-B-cloud';
    const phidA = 'ABC/L0/CLOUD-A';
    const phidB = 'ABC/L0/CLOUD-B';
    const sharedCloudId = 'icloud-shared-asset';

    // Device A uploads with its own (phid, cloud_id) pair.
    const rA = await authedHandle(
      ingest(Buffer.alloc(64, 5), {
        'X-Maple-Device-Id': deviceA,
        'X-Maple-Phasset-Id': phidA,
        'X-Maple-PHAsset-Cloud-Id': sharedCloudId,
        'X-Maple-Capture-Date': '2024-09-01T08:00:00Z',
        'X-Maple-Filename': 'IMG_DEDUP_CLOUD.HEIC',
        'X-Maple-Total-Bytes': '64',
        'X-Maple-Maple-Id': sharedMapleId,
        'Content-Range': 'bytes 0-63/64',
      }),
    );
    expect(rA.status).toBe(200);

    // Device B uploads the same content (same maple_id) with its own phid
    // but the same cloud id (because both devices see the same iCloud asset).
    const rB = await authedHandle(
      ingest(Buffer.alloc(64, 5), {
        'X-Maple-Device-Id': deviceB,
        'X-Maple-Phasset-Id': phidB,
        'X-Maple-PHAsset-Cloud-Id': sharedCloudId,
        'X-Maple-Capture-Date': '2024-09-01T08:00:00Z',
        'X-Maple-Filename': 'IMG_DEDUP_CLOUD.HEIC',
        'X-Maple-Total-Bytes': '64',
        'X-Maple-Maple-Id': sharedMapleId,
        'Content-Range': 'bytes 0-63/64',
      }),
    );
    expect(rB.status).toBe(200);

    const rows = findAssetsByMapleId(suite.handle.db, sharedMapleId);
    expect(rows).toHaveLength(1);
    const assetId = findAssetIdByMapleId(suite.handle.db, sharedMapleId);
    expect(assetId).not.toBeNull();
    const links = readPhassetLinks(suite.handle.db, assetId!);
    expect(links).toHaveLength(2);
    const byPhid = new Map(links.map((link) => [link.phasset_local_id, link]));
    expect(byPhid.get(phidA)?.phasset_cloud_id).toBe(sharedCloudId);
    expect(byPhid.get(phidB)?.phasset_cloud_id).toBe(sharedCloudId);
  });

  test('location marked missing_since + upload → file restored at that path and missing_since cleared (#4700)', async () => {
    const missingRelPath = 'indexed/IMG_LOST.HEIC';
    const missingAbsPath = path.join(suite.handle.tmpLib, missingRelPath);
    const repairBytes = Buffer.alloc(512, 0x42);
    const capturedAt = '2024-09-02T10:00:00.000Z';
    const id = deriveId(new Uint8Array(repairBytes), capturedAt, null, null);

    // Seed the asset whose file was lost on disk and marked missing_since by
    // the watcher.
    const seededId = seedBackupAsset(suite.handle.db, {
      mapleId: id.hex,
      size: repairBytes.byteLength,
      locations: [
        {
          libraryId: suite.handle.libId,
          relPath: missingRelPath,
          missingSince: '2026-06-01T00:00:00.000Z',
        },
      ],
      links: [{ deviceId, phassetLocalId: 'ABC/L0/LOST-1' }],
    });

    const res = await authedHandle(
      ingest(repairBytes, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': 'ABC/L0/LOST-1',
        'X-Maple-Capture-Date': capturedAt,
        'X-Maple-Filename': 'IMG_LOST.HEIC',
        'X-Maple-Total-Bytes': String(repairBytes.byteLength),
        'X-Maple-Maple-Id': id.hex,
        'Content-Range': `bytes 0-${repairBytes.byteLength - 1}/${repairBytes.byteLength}`,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maple_id).toBe(id.hex);
    expect(body.target_rel_path).toBe(missingRelPath);

    const onDisk = await fs.readFile(missingAbsPath);
    expect(onDisk.equals(repairBytes)).toBe(true);

    const loc = suite.handle.db
      .query(`SELECT path, filename, missing_since FROM asset_locations WHERE asset_id = ?`)
      .all(seededId.toHexString()) as {
      path: string;
      filename: string;
      missing_since: string | null;
    }[];
    expect(loc).toEqual([{ path: 'indexed', filename: 'IMG_LOST.HEIC', missing_since: null }]);
  });

  test('same-device repair upload after file vanishes on disk (even before watcher marks missing_since) restores the file (#4700)', async () => {
    const repairPhid = 'ABC/L0/LOST-SAME-DEVICE';
    const repairMapleId = '023978112ca1bbdcafac231b39a23dc1';
    const repairBytes = Buffer.alloc(256, 0x55);
    const headers = {
      'X-Maple-Device-Id': deviceId,
      'X-Maple-Phasset-Id': repairPhid,
      'X-Maple-Capture-Date': '2024-09-03T10:00:00.000Z',
      'X-Maple-Filename': 'IMG_VANISHED.HEIC',
      'X-Maple-Total-Bytes': String(repairBytes.byteLength),
      'X-Maple-Maple-Id': repairMapleId,
      'Content-Range': `bytes 0-${repairBytes.byteLength - 1}/${repairBytes.byteLength}`,
    };

    const first = await authedHandle(ingest(repairBytes, headers));
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const absPath = path.join(suite.handle.tmpLib, firstBody.target_rel_path);
    await fs.unlink(absPath);

    // Re-upload from the same device while the file is gone on disk.
    const second = await authedHandle(ingest(repairBytes, headers));
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.target_rel_path).toBe(firstBody.target_rel_path);

    const restored = await fs.readFile(absPath);
    expect(restored.equals(repairBytes)).toBe(true);
  });

  test('completed upload relocated to a new path still short-circuits at the current live path (#4700)', async () => {
    const relocatedPhid = 'ABC/L0/RELOCATED-1';
    const relocatedMapleId = '023978112ca1bbdcafac231b39a23dc9';
    const payload = Buffer.alloc(128, 0x77);
    const headers = {
      'X-Maple-Device-Id': deviceId,
      'X-Maple-Phasset-Id': relocatedPhid,
      'X-Maple-Capture-Date': '2024-09-04T10:00:00.000Z',
      'X-Maple-Filename': 'IMG_MOVED.HEIC',
      'X-Maple-Total-Bytes': String(payload.byteLength),
      'X-Maple-Maple-Id': relocatedMapleId,
      'Content-Range': `bytes 0-${payload.byteLength - 1}/${payload.byteLength}`,
    };

    const first = await authedHandle(ingest(payload, headers));
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    // Simulate relocating the stored file inside the library.
    const oldAbsPath = path.join(suite.handle.tmpLib, firstBody.target_rel_path);
    const newRelPath = 'albums/IMG_MOVED.HEIC';
    const newAbsPath = path.join(suite.handle.tmpLib, newRelPath);
    await fs.mkdir(path.dirname(newAbsPath), { recursive: true });
    await fs.rename(oldAbsPath, newAbsPath);
    suite.handle.db.run(
      `UPDATE asset_locations SET path = 'albums', filename = 'IMG_MOVED.HEIC'
        WHERE asset_id = (SELECT id FROM assets WHERE maple_id = ?)`,
      [relocatedMapleId],
    );

    // Retry only the first chunk of a multi-chunk upload — if the completed
    // session short-circuits, it returns 200 immediately with the relocated path
    // instead of 202 awaiting more chunks.
    const retry = await authedHandle(
      ingest(payload.subarray(0, 64), {
        ...headers,
        'Content-Range': `bytes 0-63/${payload.byteLength}`,
      }),
    );
    expect(retry.status).toBe(200);
    const retryBody = await retry.json();
    expect(retryBody.target_rel_path).toBe(newRelPath);
  });

  test('missing location whose path is now occupied by unrelated bytes disambiguates instead of adopting or overwriting (#4700)', async () => {
    const missingRelPath = 'indexed/IMG_REUSED.HEIC';
    const missingAbsPath = path.join(suite.handle.tmpLib, missingRelPath);
    const repairBytes = Buffer.alloc(256, 0x33);
    const unrelatedSameSizeBytes = Buffer.alloc(256, 0x99);
    const capturedAt = '2024-09-05T10:00:00.000Z';
    const id = deriveId(new Uint8Array(repairBytes), capturedAt, null, null);

    await fs.mkdir(path.dirname(missingAbsPath), { recursive: true });
    await fs.writeFile(missingAbsPath, unrelatedSameSizeBytes);

    seedBackupAsset(suite.handle.db, {
      mapleId: id.hex,
      size: repairBytes.byteLength,
      locations: [
        {
          libraryId: suite.handle.libId,
          relPath: missingRelPath,
          missingSince: '2026-06-01T00:00:00.000Z',
        },
      ],
      links: [{ deviceId, phassetLocalId: 'ABC/L0/REUSED-1' }],
    });

    const res = await authedHandle(
      ingest(repairBytes, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': 'ABC/L0/REUSED-1',
        'X-Maple-Capture-Date': capturedAt,
        'X-Maple-Filename': 'IMG_REUSED.HEIC',
        'X-Maple-Total-Bytes': String(repairBytes.byteLength),
        'X-Maple-Maple-Id': id.hex,
        'Content-Range': `bytes 0-${repairBytes.byteLength - 1}/${repairBytes.byteLength}`,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.target_rel_path).toBe('indexed/IMG_REUSED-1.HEIC');

    // Unrelated occupant at the old missing path is preserved untouched.
    expect((await fs.readFile(missingAbsPath)).equals(unrelatedSameSizeBytes)).toBe(true);
    const siblingAbsPath = path.join(suite.handle.tmpLib, 'indexed/IMG_REUSED-1.HEIC');
    expect((await fs.readFile(siblingAbsPath)).equals(repairBytes)).toBe(true);
  });
});
