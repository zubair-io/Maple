/**
 * An expired upload session is gone on read, whether or not the expiry sweep
 * has removed its row yet.
 */

import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ObjectId } from '../object-id.ts';
import { uploadSessions, type OpenOrResumeArgs } from './upload-sessions.repo.ts';
import {
  createTestDatabase,
  insertFolder,
  run,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';

const openArgs = (libraryId: ObjectId): OpenOrResumeArgs => ({
  libraryId,
  deviceId: 'device-a',
  phassetLocalId: 'phid-1',
  totalBytes: 1000,
  chunkSize: 250,
  targetRelPath: '2026/04/IMG_1.heic',
});

const expire = (db: Database, id: ObjectId) =>
  run(
    db,
    `UPDATE upload_sessions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`,
    id.toHexString(),
  );

test('a session past its expiry is not found by id', async () => {
  using handle = await createTestDatabase();
  const db = testSqliteDb(handle.db);
  const { session } = await uploadSessions.openOrResume(
    openArgs(new ObjectId(insertFolder(handle.db))),
    db,
  );

  expire(handle.db, session._id);

  expect(await uploadSessions.findById(session._id, db)).toBeNull();
});

test('reopening over an expired session starts a fresh one instead of resuming it', async () => {
  using handle = await createTestDatabase();
  const db = testSqliteDb(handle.db);
  const library = new ObjectId(insertFolder(handle.db));
  const first = await uploadSessions.openOrResume(openArgs(library), db);
  await uploadSessions.recordChunk({ sessionId: first.session._id, bytesReceived: 250 }, db);
  expire(handle.db, first.session._id);

  const again = await uploadSessions.openOrResume(openArgs(library), db);

  expect(again.session._id.toHexString()).not.toBe(first.session._id.toHexString());
  expect(again.session.received_bytes).toBe(0);
  expect(await uploadSessions.findById(first.session._id, db)).toBeNull();
  expect(
    handle.db.query(`SELECT COUNT(*) AS n FROM upload_sessions`).get() as { n: number },
  ).toEqual({ n: 1 });
});
