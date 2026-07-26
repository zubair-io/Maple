/**
 * Screenshot routing for the backup-ingest route.
 *
 * A screenshot detected at ingest (by the device-reported filename) lands in
 * `<year>/Screenshot` and seeds `is_screenshot: true` on the row, so the asset
 * matches its on-disk home before the EXIF stage runs. Split into its own file
 * to keep the 600-LOC budget on `backup-ingest.test.ts` clear.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { ObjectId } from 'mongodb';
import { authedHandle } from './helpers/authed-handle.ts';
import { foldersCollection, assetsCollection, uploadSessionsCollection } from '../src/db/client.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const libId = new ObjectId();
const deviceId = 'test-device-screenshot';
let tmpLib: string;

beforeAll(async () => {
  tmpLib = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-ingest-screenshot-'));
  const f = await foldersCollection();
  await f.insertOne({
    _id: libId,
    path: tmpLib,
    label: 'screenshot-test',
    created_at: new Date(),
    file_count: 0,
  } as any);
  const a = await assetsCollection();
  await a.deleteMany({ 'phasset_links.device_id': deviceId });
  const u = await uploadSessionsCollection();
  await u.deleteMany({ device_id: deviceId });
});

afterAll(async () => {
  try {
    const a = await assetsCollection();
    await a.deleteMany({
      $or: [{ 'fileinfo.library_id': libId }, { 'phasset_links.device_id': deviceId }],
    });
    const f = await foldersCollection();
    await f.deleteMany({ _id: libId });
    const u = await uploadSessionsCollection();
    await u.deleteMany({ library_id: libId });
  } catch {
    // Best-effort teardown — never mask a test failure with a cleanup error.
  }
  if (tmpLib) {
    try {
      await fs.rm(tmpLib, { recursive: true, force: true });
    } catch {
      // Teardown is best-effort; the OS will reclaim the tmpdir.
    }
  }
});

function ingest(body: Buffer, headers: Record<string, string>): Request {
  return new Request(`http://localhost/api/libraries/${libId.toHexString()}/backup/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body,
  });
}

describe('backup-ingest screenshot routing', () => {
  test('a Screenshot-named upload lands in <year>/Screenshot and flags is_screenshot', async () => {
    const bytes = Buffer.alloc(64, 9);
    const res = await authedHandle(
      ingest(bytes, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': 'SS/L0/001',
        'X-Maple-Capture-Date': '2024-03-15T10:30:00Z',
        'X-Maple-Filename': 'Screenshot 2024-03-15 at 10.04.32.png',
        'X-Maple-Total-Bytes': '64',
        'X-Maple-Maple-Id': 'screenshot-1',
        // Note: a GPS fix is supplied to prove the screenshot folder wins over
        // the location layout.
        'X-Maple-Lat': '37.7749',
        'X-Maple-Lon': '-122.4194',
        'Content-Range': 'bytes 0-63/64',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.target_rel_path).toBe('2024/Screenshot/Screenshot 2024-03-15 at 10.04.32.png');

    const a = await assetsCollection();
    const doc = await a.findOne({ maple_id: 'screenshot-1' });
    expect(doc?.fileinfo?.[0].path).toBe('2024/Screenshot');
    expect(doc?.is_screenshot).toBe(true);

    // And the bytes really landed there on disk.
    expect(
      await fs.readFile(path.join(tmpLib, '2024/Screenshot/Screenshot 2024-03-15 at 10.04.32.png')),
    ).toHaveLength(64);
  });

  test('a normal photo is unaffected (date fallback, is_screenshot false)', async () => {
    const bytes = Buffer.alloc(64, 3);
    const res = await authedHandle(
      ingest(bytes, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': 'SS/L0/002',
        'X-Maple-Capture-Date': '2024-03-15T10:30:00Z',
        'X-Maple-Filename': 'IMG_2024.HEIC',
        'X-Maple-Total-Bytes': '64',
        'X-Maple-Maple-Id': 'screenshot-2',
        'Content-Range': 'bytes 0-63/64',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.target_rel_path).toBe('2024/Misc/IMG_2024.HEIC');

    const a = await assetsCollection();
    const doc = await a.findOne({ maple_id: 'screenshot-2' });
    expect(doc?.fileinfo?.[0].path).toBe('2024/Misc');
    expect(doc?.is_screenshot).toBe(false);
  });

  test('a Screenshot-named VIDEO is not routed to <year>/Screenshot (#2325)', async () => {
    const bytes = Buffer.alloc(64, 7);
    const res = await authedHandle(
      ingest(bytes, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': 'SS/L0/003',
        'X-Maple-Capture-Date': '2024-03-15T10:30:00Z',
        // A screen recording carries a screenshot-shaped name on some
        // devices. It is still a video, so it belongs in the normal date
        // layout, not the Screenshot folder.
        'X-Maple-Filename': 'Screenshot_20240315_103000.mp4',
        'X-Maple-Total-Bytes': '64',
        'X-Maple-Maple-Id': 'screenshot-video-1',
        'Content-Range': 'bytes 0-63/64',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.target_rel_path).toBe('2024/Misc/Screenshot_20240315_103000.mp4');

    const a = await assetsCollection();
    const doc = await a.findOne({ maple_id: 'screenshot-video-1' });
    expect(doc?.fileinfo?.[0].path).toBe('2024/Misc');
    expect(doc?.is_screenshot).toBe(false);

    // And the bytes really landed outside the Screenshot folder.
    expect(
      await fs.readFile(path.join(tmpLib, '2024/Misc/Screenshot_20240315_103000.mp4')),
    ).toHaveLength(64);
  });
});
