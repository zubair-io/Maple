/**
 * POST /api/libraries/:id/backup/ingest — happy paths and basic validation.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for each test (#3787), with the library rooted at a per-test tmp directory.
 * Sibling files cover the other scenarios so each stays under the file-size
 * budget (#114, refs #134, closes #252):
 *   - `backup-ingest-errors.test.ts`         — error / edge cases
 *   - `backup-ingest-cloud-dedup.test.ts`    — cloud-id + advanced dedup
 *   - `backup-ingest-fileinfo.test.ts`       — asset_locations content-addressing
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import fs from 'node:fs/promises';
import path from 'node:path';
import { authedHandle } from './helpers/authed-handle.ts';
import {
  findAssetIdByMapleId,
  findAssetsByMapleId,
  findPhassetLinksByLocalId,
  readPhassetLinks,
} from './helpers/sqlite-fixtures.ts';
import { makeIngestRequest, setupBackupIngestSuite } from './backup-ingest-helpers.ts';

const deviceId = 'test-device-ingest';
const phid = 'ABC/L0/001';
const phid2 = 'ABC/L0/002';

const suite = setupBackupIngestSuite({ withTokyoGeocode: true });
beforeEach(suite.setup);
afterEach(suite.teardown);

const ingest = makeIngestRequest(suite.handle);

describe('POST /api/libraries/:id/backup/ingest — happy paths', () => {
  test('happy path single chunk with GPS → asset row + located path', async () => {
    const bytes = Buffer.alloc(256, 1);
    const res = await authedHandle(
      ingest(bytes, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid,
        'X-Maple-Capture-Date': '2024-03-15T10:30:00Z',
        'X-Maple-Lat': '35.68',
        'X-Maple-Lon': '139.69',
        'X-Maple-Filename': 'IMG_0420.HEIC',
        'X-Maple-Total-Bytes': '256',
        'X-Maple-Maple-Id': '026ca13d52ca70c883e0f0bb101e425a',
        'Content-Range': 'bytes 0-255/256',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maple_id).toBe('026ca13d52ca70c883e0f0bb101e425a');
    expect(body.target_rel_path).toBe('2024/Japan/Tokyo/IMG_0420.HEIC');

    const onDisk = await fs.readFile(path.join(suite.handle.tmpLib, body.target_rel_path));
    expect(onDisk.byteLength).toBe(256);

    // The device link is the record that this PHAsset was ingested.
    const links = findPhassetLinksByLocalId(suite.handle.db, phid);
    expect(links).toHaveLength(1);
    expect(links[0].device_id).toBe(deviceId);
  });

  test('resume across two chunks', async () => {
    const r1 = await authedHandle(
      ingest(Buffer.alloc(128, 2), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid2,
        'X-Maple-Capture-Date': '2024-03-15T10:30:00Z',
        'X-Maple-Filename': 'IMG_0421.HEIC',
        'X-Maple-Total-Bytes': '256',
        'Content-Range': 'bytes 0-127/256',
      }),
    );
    expect(r1.status).toBe(202);
    const b1 = await r1.json();
    expect(b1.next_offset).toBe(128);

    const r2 = await authedHandle(
      ingest(Buffer.alloc(128, 2), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid2,
        'X-Maple-Capture-Date': '2024-03-15T10:30:00Z',
        'X-Maple-Filename': 'IMG_0421.HEIC',
        'X-Maple-Total-Bytes': '256',
        'X-Maple-Maple-Id': '028f61ad5cfa0c471c8cbf810ea285cb',
        'Content-Range': 'bytes 128-255/256',
      }),
    );
    expect(r2.status).toBe(200);
  });

  test('retry after completed upload → 200 short-circuit, no duplicate asset row', async () => {
    // Regression for #223: original ingest completes, but a downstream step
    // in the device pipeline (sidecar / rendered / live) fails and the
    // engine re-enqueues the task. The retry must NOT 409-loop — the server
    // recognises the completed session and short-circuits to 200 with the
    // stored maple_id + target_rel_path.
    const retryPhid = 'ABC/L0/RETRY';
    const retryMapleId = '02161cb9ee6ab785420f9ffa3fe9e07f';
    const bytes = Buffer.alloc(128, 7);
    const headers = {
      'X-Maple-Device-Id': deviceId,
      'X-Maple-Phasset-Id': retryPhid,
      'X-Maple-Capture-Date': '2024-04-01T08:00:00Z',
      'X-Maple-Filename': 'IMG_RETRY.HEIC',
      'X-Maple-Total-Bytes': '128',
      'X-Maple-Maple-Id': retryMapleId,
      'Content-Range': 'bytes 0-127/128',
    };

    // First attempt — original ingest completes.
    const first = await authedHandle(ingest(bytes, headers));
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.maple_id).toBe(retryMapleId);
    const firstTargetRelPath = firstBody.target_rel_path;

    // Simulate the device pipeline failing post-ingest and retrying. The
    // bytes are identical (same asset, same total, same path). Before the
    // fix this returned 409 without an expected_offset and the client gave
    // up after eight retries.
    const second = await authedHandle(ingest(bytes, headers));
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.maple_id).toBe(retryMapleId);
    expect(secondBody.target_rel_path).toBe(firstTargetRelPath);

    // Still exactly one asset row for this content — no duplicate row, no
    // duplicate link.
    const rows = findAssetsByMapleId(suite.handle.db, retryMapleId);
    expect(rows).toHaveLength(1);
    const assetId = findAssetIdByMapleId(suite.handle.db, retryMapleId);
    expect(assetId).not.toBeNull();
    const links = readPhassetLinks(suite.handle.db, assetId!);
    expect(links).toHaveLength(1);
    expect(links[0].phasset_local_id).toBe(retryPhid);
  });

  test('missing required header → 400', async () => {
    const r = await authedHandle(
      ingest(Buffer.alloc(16), {
        'X-Maple-Device-Id': deviceId,
        // no phasset id
        'X-Maple-Total-Bytes': '16',
        'Content-Range': 'bytes 0-15/16',
      }),
    );
    expect(r.status).toBe(400);
  });

  test("409 when resume offset doesn't match server's received_bytes", async () => {
    const phid3 = 'ABC/L0/003';
    const r1 = await authedHandle(
      ingest(Buffer.alloc(128, 3), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid3,
        'X-Maple-Capture-Date': '2024-03-15T10:30:00Z',
        'X-Maple-Filename': 'IMG_0422.HEIC',
        'X-Maple-Total-Bytes': '256',
        'Content-Range': 'bytes 0-127/256',
      }),
    );
    expect(r1.status).toBe(202);
    const b1 = await r1.json();
    expect(b1.next_offset).toBe(128);

    const r2 = await authedHandle(
      ingest(Buffer.alloc(128, 3), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid3,
        'X-Maple-Capture-Date': '2024-03-15T10:30:00Z',
        'X-Maple-Filename': 'IMG_0422.HEIC',
        'X-Maple-Total-Bytes': '256',
        'Content-Range': 'bytes 64-191/256', // wrong start — server expects 128
      }),
    );
    expect(r2.status).toBe(409);
    const b2 = await r2.json();
    expect(b2.expected_offset).toBe(128);
  });

  test('second device with same maple_id → extra link row, no new asset row', async () => {
    const sharedMapleId = '02155ffeb77424a83923b93d70c9451b';
    const deviceA = 'device-A-dedup';
    const deviceB = 'device-B-dedup';
    const phidA = 'ABC/L0/010';
    const phidB = 'ABC/L0/011';

    // Device A uploads a complete single-chunk asset.
    const rA = await authedHandle(
      ingest(Buffer.alloc(64, 5), {
        'X-Maple-Device-Id': deviceA,
        'X-Maple-Phasset-Id': phidA,
        'X-Maple-Capture-Date': '2024-06-01T08:00:00Z',
        'X-Maple-Filename': 'IMG_SHARED.HEIC',
        'X-Maple-Total-Bytes': '64',
        'X-Maple-Maple-Id': sharedMapleId,
        'Content-Range': 'bytes 0-63/64',
      }),
    );
    expect(rA.status).toBe(200);

    // Device B uploads the same asset (same maple_id, different phid).
    const rB = await authedHandle(
      ingest(Buffer.alloc(64, 5), {
        'X-Maple-Device-Id': deviceB,
        'X-Maple-Phasset-Id': phidB,
        'X-Maple-Capture-Date': '2024-06-01T08:00:00Z',
        'X-Maple-Filename': 'IMG_SHARED.HEIC',
        'X-Maple-Total-Bytes': '64',
        'X-Maple-Maple-Id': sharedMapleId,
        'Content-Range': 'bytes 0-63/64',
      }),
    );
    expect(rB.status).toBe(200);

    // Exactly one asset row with two links.
    const rows = findAssetsByMapleId(suite.handle.db, sharedMapleId);
    expect(rows).toHaveLength(1);
    const assetId = findAssetIdByMapleId(suite.handle.db, sharedMapleId);
    expect(assetId).not.toBeNull();
    const links = readPhassetLinks(suite.handle.db, assetId!);
    expect(links).toHaveLength(2);
    const deviceIds = links.map((link) => link.device_id);
    expect(deviceIds).toContain(deviceA);
    expect(deviceIds).toContain(deviceB);
  });

  test('library not found → 404', async () => {
    const fake = new ObjectId();
    const r = await authedHandle(
      new Request(`http://localhost/api/libraries/${fake.toHexString()}/backup/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Maple-Device-Id': deviceId,
          'X-Maple-Phasset-Id': 'PX',
          'X-Maple-Capture-Date': '2024-03-15T10:30:00Z',
          'X-Maple-Filename': 'x.heic',
          'X-Maple-Total-Bytes': '1',
          'X-Maple-Maple-Id': '022d711642b726b04401627ca9fbac32',
          'Content-Range': 'bytes 0-0/1',
        },
        body: Buffer.alloc(1),
      }),
    );
    expect(r.status).toBe(404);
  });
});
