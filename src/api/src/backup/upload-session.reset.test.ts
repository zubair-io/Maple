import { describe, test, expect, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { uploadSessions } from './upload-session.ts';
import { uploadSessionsCollection } from '../db/client.ts';

/**
 * Boot-time bulk reset, split out from upload-session.test.ts to keep that
 * file under the 600-line hard budget. The reset method itself is paired
 * with `clearBackupChunkDir()` in `index.ts::start()` — at boot the disk
 * `.part` files are wiped, so any Mongo row still claiming progress is
 * lying and would re-trip the client's 409 loop.
 */
describe('uploadSessions.resetAllInProgressBytes', () => {
  const libraryId = new ObjectId();
  const deviceId = 'dev-reset';

  beforeEach(async () => {
    const c = await uploadSessionsCollection();
    await c.deleteMany({ library_id: libraryId });
  });

  test('zeroes received_bytes on open rows only', async () => {
    const c = await uploadSessionsCollection();
    const now = new Date();
    // Open session mid-upload — should be reset.
    const openMid = new ObjectId();
    // Open session with received_bytes == total (the stuck-loop case) — should be reset.
    const openFull = new ObjectId();
    // Open session at received_bytes 0 — should be untouched (no $gt: 0 match).
    const openZero = new ObjectId();
    // Completed session with received_bytes == total — must NOT be touched.
    const completed = new ObjectId();
    // Abandoned session — must NOT be touched.
    const abandoned = new ObjectId();
    await c.insertMany([
      {
        _id: openMid,
        library_id: libraryId,
        device_id: deviceId,
        phasset_local_id: 'open-mid',
        target_rel_path: 'a',
        total_bytes: 1000,
        received_bytes: 400,
        chunk_size: 100,
        state: 'open',
        created_at: now,
        updated_at: now,
      } as any,
      {
        _id: openFull,
        library_id: libraryId,
        device_id: deviceId,
        phasset_local_id: 'open-full',
        target_rel_path: 'b',
        total_bytes: 1000,
        received_bytes: 1000,
        chunk_size: 100,
        state: 'open',
        created_at: now,
        updated_at: now,
      } as any,
      {
        _id: openZero,
        library_id: libraryId,
        device_id: deviceId,
        phasset_local_id: 'open-zero',
        target_rel_path: 'c',
        total_bytes: 1000,
        received_bytes: 0,
        chunk_size: 100,
        state: 'open',
        created_at: now,
        updated_at: now,
      } as any,
      {
        _id: completed,
        library_id: libraryId,
        device_id: deviceId,
        phasset_local_id: 'completed',
        target_rel_path: 'd',
        total_bytes: 1000,
        received_bytes: 1000,
        chunk_size: 100,
        state: 'completed',
        maple_id: 'm-1',
        created_at: now,
        updated_at: now,
      } as any,
      {
        _id: abandoned,
        library_id: libraryId,
        device_id: deviceId,
        phasset_local_id: 'abandoned',
        target_rel_path: 'e',
        total_bytes: 1000,
        received_bytes: 800,
        chunk_size: 100,
        state: 'abandoned',
        created_at: now,
        updated_at: now,
      } as any,
    ]);

    const reset = await uploadSessions.resetAllInProgressBytes();
    // ≥2 because shared test DB may carry other open rows from sibling
    // suites (same pattern as gcAbandoned's `toBeGreaterThanOrEqual`).
    expect(reset).toBeGreaterThanOrEqual(2);

    expect((await c.findOne({ _id: openMid }))!.received_bytes).toBe(0);
    expect((await c.findOne({ _id: openFull }))!.received_bytes).toBe(0);
    expect((await c.findOne({ _id: openZero }))!.received_bytes).toBe(0);
    expect((await c.findOne({ _id: completed }))!.received_bytes).toBe(1000);
    expect((await c.findOne({ _id: abandoned }))!.received_bytes).toBe(800);
  });
});
