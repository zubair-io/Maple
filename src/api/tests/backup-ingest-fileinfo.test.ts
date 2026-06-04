/**
 * fileinfo[0] assertions for the backup-ingest route.
 *
 * Split out of `backup-ingest.test.ts` because that file is already at the
 * 600-LOC hard budget. The route logic itself is exercised by the parent
 * test file; this one isolates the content-addressing assertions so the
 * parent doesn't grow further while the migration progresses.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { ObjectId } from 'mongodb';
import { app } from '../src/index.ts';
import { foldersCollection, assetsCollection, uploadSessionsCollection } from '../src/db/client.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const libId = new ObjectId();
const deviceId = 'test-device-fileinfo';
const phid = 'FI/L0/001';
let tmpLib: string;

beforeAll(async () => {
  tmpLib = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-ingest-fileinfo-'));
  const f = await foldersCollection();
  await f.insertOne({
    _id: libId,
    path: tmpLib,
    label: 'fileinfo-test',
    created_at: new Date(),
    file_count: 0,
  } as any);
  const a = await assetsCollection();
  await a.deleteMany({ 'phasset_links.device_id': deviceId });
  const u = await uploadSessionsCollection();
  await u.deleteMany({ device_id: deviceId });
});

afterAll(async () => {
  // Drop every row this suite wrote so it doesn't leak into the shared Mongo
  // for later test files (KTLO #895): the ingested asset(s), the upload
  // session, and the seeded folder. Scoped to this suite's libId/deviceId to
  // stay parallel-safe with the sibling backup suites.
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
  // Guard tmpLib: beforeAll can throw before assigning it, and an unguarded
  // fs.rm(undefined) would throw and mask the original failure (mirrors the
  // guard in setupBackupIngestSuite).
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

describe('backup-ingest writes fileinfo[0]', () => {
  test('insert: fileinfo[0] mirrors target_rel_path split into (dir, filename, library_id)', async () => {
    const bytes = Buffer.alloc(128, 7);
    const res = await app.handle(
      ingest(bytes, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid,
        'X-Maple-Capture-Date': '2024-03-15T10:30:00Z',
        'X-Maple-Filename': 'IMG_FI.HEIC',
        'X-Maple-Total-Bytes': '128',
        'X-Maple-Maple-Id': 'fileinfo-1',
        // No GPS → path-formatter falls back to date-only buckets.
        'Content-Range': 'bytes 0-127/128',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    const a = await assetsCollection();
    const doc = await a.findOne({ maple_id: 'fileinfo-1' });
    expect(doc).toBeTruthy();
    expect(doc?.fileinfo).toHaveLength(1);
    // path = directory part of body.target_rel_path; filename = basename.
    const expectedDir = path.dirname(body.target_rel_path);
    expect(doc?.fileinfo?.[0].path).toBe(expectedDir === '.' ? '' : expectedDir);
    expect(doc?.fileinfo?.[0].filename).toBe('IMG_FI.HEIC');
    expect(doc?.fileinfo?.[0].library_id.equals(libId)).toBe(true);
  });

  test('FileInfo.path stays POSIX (forward-slashed) even on hosts where path.sep is \\', async () => {
    // This is a contract pin — the insert path normalizes path.sep → '/'.
    // On Linux/macOS (the test environment) path.sep is already '/', so we
    // just confirm no backslashes leak into storage.
    const a = await assetsCollection();
    const doc = await a.findOne({ maple_id: 'fileinfo-1' });
    expect(doc?.fileinfo?.[0].path).not.toContain('\\');
  });
});
