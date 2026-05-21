import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { ObjectId } from 'mongodb';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from '../src/index.ts';
import { assetsCollection } from '../src/db/client.ts';
import { makeIngestRequest, setupBackupIngestSuite } from './backup-ingest-helpers.ts';

// Cloud-id persistence + advanced dedup slice of the
// `POST /api/libraries/:id/backup/ingest` suite. The happy paths live in
// `backup-ingest.test.ts`; error/edge cases in `backup-ingest-errors.test.ts`.
// Split to keep each file under the file-size budget (#114).
//
// Unique deviceId so parallel suites don't wipe each other's data on beforeAll.
const deviceId = 'test-device-ingest-cloud';

const suite = setupBackupIngestSuite({ deviceId });
beforeAll(suite.beforeAll);
afterAll(suite.afterAll);

const ingest = makeIngestRequest(suite.handle.libId);

describe('POST /api/libraries/:id/backup/ingest — cloud-id + advanced dedup', () => {
  test('backup upload with spec-form maple_id matching pre-seeded AssetDoc → dedup, no second file', async () => {
    // End-to-end dedup proof for the device-side spec-form maple_id fix:
    // an indexer-style AssetDoc exists on disk + in Mongo, and the device
    // backs up the same content with the matching spec-form id. The server
    // must short-circuit on `findOne({ maple_id })` and not write a second
    // copy.
    const { deriveId } = await import('../src/indexer/id.ts');

    // Simulate "indexer scanned this file" — write the file to the library
    // folder directly, derive a spec-form id from its head, insert the
    // AssetDoc with that id.
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

    const a = await assetsCollection();
    await a.insertOne({
      _id: new ObjectId(),
      folder_id: suite.handle.libId,
      filename: 'IMG_INDEXED.HEIC',
      abs_path: indexerAbsPath,
      size: sharedBytes.byteLength,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      maple_id: id.hex,
      phasset_links: [],
      deleted_from_photos: false,
    } as never);

    // Now the device sends a backup with the same content + same spec-form id.
    const devicePhid = 'ABC/L0/SPEC-FORM';
    const deviceForId = 'device-spec-form';
    const res = await app.handle(
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

    // Exactly one AssetDoc; phasset_links got the device link pushed onto it.
    const rows = await a.find({ maple_id: id.hex }).toArray();
    expect(rows.length).toBe(1);
    expect(rows[0].phasset_links.length).toBe(1);
    expect(rows[0].phasset_links[0].device_id).toBe(deviceForId);
    expect(rows[0].phasset_links[0].phasset_local_id).toBe(devicePhid);

    // Only the indexer's file exists on disk under the library folder —
    // no second copy was written under the device's would-be target path.
    // The "phid-routing" target path would have been derived from
    // capture_date + filename → e.g. `2024/2024/09-01/IMG_INDEXED.HEIC` —
    // walk the folder tree and assert exactly one IMG_INDEXED.HEIC exists.
    async function walk(dir: string): Promise<string[]> {
      const out: string[] = [];
      const ents = await fs.readdir(dir, { withFileTypes: true });
      for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        else out.push(full);
      }
      return out;
    }
    const allFiles = await walk(suite.handle.tmpLib);
    const sharedNameMatches = allFiles.filter((p) => p.endsWith('IMG_INDEXED.HEIC'));
    expect(sharedNameMatches.length).toBe(1);
    expect(sharedNameMatches[0]).toBe(indexerAbsPath);
  });

  test('cross-device: second device gets 423 while peer is actively uploading', async () => {
    const sharedCloudId = 'icloud-BUSY-PHOTO';
    // Phone starts a multi-chunk upload but doesn't finish yet.
    const phoneR1 = await app.handle(
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
    const desktopR = await app.handle(
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

  test('X-Maple-PHAsset-Cloud-Id is persisted into phasset_links', async () => {
    const phidCloud = 'ABC/L0/CLOUD1';
    const cloudId = 'icloud-XYZ-stable-across-devices';
    const res = await app.handle(
      ingest(Buffer.alloc(64, 13), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phidCloud,
        'X-Maple-PHAsset-Cloud-Id': cloudId,
        'X-Maple-Capture-Date': '2024-08-01T08:00:00Z',
        'X-Maple-Filename': 'IMG_CLOUD.HEIC',
        'X-Maple-Total-Bytes': '64',
        'X-Maple-Maple-Id': 'cloud-id-maple-id',
        'Content-Range': 'bytes 0-63/64',
      }),
    );
    expect(res.status).toBe(200);

    const a = await assetsCollection();
    const doc = await a.findOne({ 'phasset_links.phasset_local_id': phidCloud });
    expect(doc).toBeTruthy();
    const link = doc!.phasset_links!.find((l) => l.phasset_local_id === phidCloud);
    expect(link).toBeTruthy();
    expect(link!.phasset_cloud_id).toBe(cloudId);
  });

  test('absent X-Maple-PHAsset-Cloud-Id leaves phasset_cloud_id unset', async () => {
    const phidNoCloud = 'ABC/L0/NOCLOUD';
    const res = await app.handle(
      ingest(Buffer.alloc(64, 14), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phidNoCloud,
        // No X-Maple-PHAsset-Cloud-Id header — simulates iCloud Photos off.
        'X-Maple-Capture-Date': '2024-08-01T08:00:00Z',
        'X-Maple-Filename': 'IMG_NOCLOUD.HEIC',
        'X-Maple-Total-Bytes': '64',
        'X-Maple-Maple-Id': 'no-cloud-maple-id',
        'Content-Range': 'bytes 0-63/64',
      }),
    );
    expect(res.status).toBe(200);

    const a = await assetsCollection();
    const doc = await a.findOne({ 'phasset_links.phasset_local_id': phidNoCloud });
    expect(doc).toBeTruthy();
    const link = doc!.phasset_links!.find((l) => l.phasset_local_id === phidNoCloud);
    expect(link).toBeTruthy();
    expect(link!.phasset_cloud_id).toBeUndefined();
  });

  test("second device with same maple_id $push's the link including its cloud id", async () => {
    const sharedMapleId = 'shared-maple-id-cloud-test';
    const deviceA = 'device-A-cloud';
    const deviceB = 'device-B-cloud';
    const phidA = 'ABC/L0/CLOUD-A';
    const phidB = 'ABC/L0/CLOUD-B';
    const sharedCloudId = 'icloud-shared-asset';

    // Device A uploads with its own (phid, cloud_id) pair.
    const rA = await app.handle(
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
    const rB = await app.handle(
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

    const a = await assetsCollection();
    const docs = await a.find({ maple_id: sharedMapleId }).toArray();
    expect(docs.length).toBe(1);
    const links = docs[0].phasset_links ?? [];
    expect(links.length).toBe(2);
    const byPhid = new Map(links.map((l: any) => [l.phasset_local_id, l]));
    expect(byPhid.get(phidA)?.phasset_cloud_id).toBe(sharedCloudId);
    expect(byPhid.get(phidB)?.phasset_cloud_id).toBe(sharedCloudId);
  });
});
