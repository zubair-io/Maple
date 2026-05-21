import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from '../src/index.ts';
import { makeIngestRequest, setupBackupIngestSuite } from './backup-ingest-helpers.ts';

// Error / edge-case slice of the `POST /api/libraries/:id/backup/ingest` suite.
// The happy paths live in `backup-ingest.test.ts`; the cloud-id / spec-form-dedup
// tests in `backup-ingest-cloud-dedup.test.ts`. Split to keep each file under
// the file-size budget (#114).
//
// Pick a deviceId distinct from the happy-path suite so this file can run in
// parallel without wiping the other suite's `assetsCollection` rows during
// its beforeAll cleanup.
const deviceId = 'test-device-ingest-errors';

const suite = setupBackupIngestSuite({ deviceId });
beforeAll(suite.beforeAll);
afterAll(suite.afterAll);

const ingest = makeIngestRequest(suite.handle.libId);

describe('POST /api/libraries/:id/backup/ingest — errors + edge cases', () => {
  test('Content-Range end < start → 400', async () => {
    const r = await app.handle(
      ingest(Buffer.alloc(8), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': 'range-test-1',
        'X-Maple-Capture-Date': '2024-03-15T10:30:00Z',
        'X-Maple-Filename': 'IMG_range.HEIC',
        'X-Maple-Total-Bytes': '256',
        'Content-Range': 'bytes 5-3/256', // end < start
      }),
    );
    expect(r.status).toBe(400);
  });

  test('body shorter than Content-Range claims → 400', async () => {
    const r = await app.handle(
      ingest(Buffer.alloc(8), {
        // only 8 bytes
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': 'range-test-2',
        'X-Maple-Capture-Date': '2024-03-15T10:30:00Z',
        'X-Maple-Filename': 'IMG_range2.HEIC',
        'X-Maple-Total-Bytes': '256',
        'Content-Range': 'bytes 0-127/256', // claims 128 bytes
      }),
    );
    expect(r.status).toBe(400);
  });

  test('tmp file deleted between chunks → 409 with expected_offset 0', async () => {
    const phidTmp = 'ABC/L0/TMP1';
    const backupTmpDir = process.env.MAPLE_BACKUP_TMP ?? '/tmp/maple-backup-chunks';
    const { uploadSessionsCollection } = await import('../src/db/client.ts');

    // First chunk — establishes session
    const r1 = await app.handle(
      ingest(Buffer.alloc(128, 9), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phidTmp,
        'X-Maple-Capture-Date': '2024-05-01T08:00:00Z',
        'X-Maple-Filename': 'IMG_tmp_test.HEIC',
        'X-Maple-Total-Bytes': '256',
        'Content-Range': 'bytes 0-127/256',
      }),
    );
    expect(r1.status).toBe(202);

    // Find the session id and delete the .part file
    const u = await uploadSessionsCollection();
    const sess = await u.findOne({ device_id: deviceId, phasset_local_id: phidTmp });
    expect(sess).toBeTruthy();
    const partFile = `${backupTmpDir}/${sess!._id.toHexString()}.part`;
    try {
      await import('node:fs/promises').then((f) => f.unlink(partFile));
    } catch {
      /* already gone */
    }

    // Second chunk — server should detect missing tmp file and return 409
    const r2 = await app.handle(
      ingest(Buffer.alloc(128, 9), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phidTmp,
        'X-Maple-Capture-Date': '2024-05-01T08:00:00Z',
        'X-Maple-Filename': 'IMG_tmp_test.HEIC',
        'X-Maple-Total-Bytes': '256',
        'X-Maple-Maple-Id': 'tmp-test-id',
        'Content-Range': 'bytes 128-255/256',
      }),
    );
    expect(r2.status).toBe(409);
    const b2 = await r2.json();
    expect(b2.expected_offset).toBe(0);
  });

  test('resume with different filename self-heals — server resets, asks client to restart from 0', async () => {
    const phidResume = 'ABC/L0/099';
    // Open session with IMG_a.heic.
    const r1 = await app.handle(
      ingest(Buffer.alloc(128, 7), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phidResume,
        'X-Maple-Capture-Date': '2024-04-01T08:00:00Z',
        'X-Maple-Filename': 'IMG_a.heic',
        'X-Maple-Total-Bytes': '256',
        'Content-Range': 'bytes 0-127/256',
      }),
    );
    expect(r1.status).toBe(202);

    // Same phid, different filename — the metadata mismatch is self-healed
    // server-side (session reset to offset 0 in place). The client's request
    // still has start=128, so it gets a normal 409 with expected_offset=0
    // telling it to restart from the top.
    const r2 = await app.handle(
      ingest(Buffer.alloc(128, 7), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phidResume,
        'X-Maple-Capture-Date': '2024-04-01T08:00:00Z',
        'X-Maple-Filename': 'IMG_b.heic', // different filename → new target_rel_path
        'X-Maple-Total-Bytes': '256',
        'Content-Range': 'bytes 128-255/256',
      }),
    );
    expect(r2.status).toBe(409);
    const b2 = await r2.json();
    expect(b2.expected_offset).toBe(0);

    // Client follows the expected_offset and restarts at 0 with the new
    // filename — should now succeed end-to-end.
    const r3 = await app.handle(
      ingest(Buffer.alloc(128, 8), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phidResume,
        'X-Maple-Capture-Date': '2024-04-01T08:00:00Z',
        'X-Maple-Filename': 'IMG_b.heic',
        'X-Maple-Total-Bytes': '256',
        'Content-Range': 'bytes 0-127/256',
      }),
    );
    expect(r3.status).toBe(202);

    const r4 = await app.handle(
      ingest(Buffer.alloc(128, 8), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phidResume,
        'X-Maple-Capture-Date': '2024-04-01T08:00:00Z',
        'X-Maple-Filename': 'IMG_b.heic',
        'X-Maple-Total-Bytes': '256',
        'X-Maple-Maple-Id': 'self-heal-restart-test',
        'Content-Range': 'bytes 128-255/256',
      }),
    );
    expect(r4.status).toBe(200);
  });

  test('path collision (file already on disk, no Mongo row) → 500', async () => {
    // Pre-create the file at the destination path before uploading
    const captureDate = '2024-07-04T12:00:00Z';
    const fname = 'IMG_COLLISION.HEIC';
    const targetDir = path.join(suite.handle.tmpLib, '2024/07/04');
    await fs.mkdir(targetDir, { recursive: true });
    const preExistingPath = path.join(targetDir, fname);
    await fs.writeFile(preExistingPath, Buffer.alloc(64, 0));

    const rCollide = await app.handle(
      ingest(Buffer.alloc(64, 11), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': 'ABC/L0/COLLIDE',
        'X-Maple-Capture-Date': captureDate,
        'X-Maple-Filename': fname,
        'X-Maple-Total-Bytes': '64',
        'X-Maple-Maple-Id': 'collision-maple-id',
        'Content-Range': 'bytes 0-63/64',
      }),
    );
    expect(rCollide.status).toBe(500);
    const b = await rCollide.json();
    expect(b.error).toContain('path collision');

    // Clean up
    await fs.unlink(preExistingPath);
  });
});
