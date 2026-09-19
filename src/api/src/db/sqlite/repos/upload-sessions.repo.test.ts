/**
 * The upload-session verbs against a real database.
 *
 * `openOrResume` is almost all of this file, and deliberately so: it is one
 * function with seven outcomes, each of which exists because a device retry
 * arrived in a state the previous attempt left behind. The branches are what
 * keep a client out of a retry loop it cannot escape, so each one is pinned
 * here rather than inferred from the shape of the code.
 *
 * The other thing these check is the `$unset` translation. A cleared field is a
 * NULL column, and the DTO must report it as an absent key — `'maple_id' in
 * session` is the assertion, not `toBeUndefined()`, because those differ for a
 * key that exists holding `undefined`.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../../object-id.ts';
import {
  BusyElsewhereError,
  CROSS_DEVICE_BUSY_WINDOW_MS,
  uploadSessions,
  type OpenOrResumeArgs,
  type OpenOrResumeResult,
} from './upload-sessions.repo.ts';
import {
  createTestDatabase,
  insertFolder,
  run,
  testSqliteDb,
} from '../test-sqlite.test-helpers.ts';
import type { Database } from 'bun:sqlite';

const DAY_MS = 24 * 3600 * 1000;

function openArgs(
  libraryId: ObjectId,
  overrides: Partial<OpenOrResumeArgs> = {},
): OpenOrResumeArgs {
  return {
    libraryId,
    deviceId: 'device-a',
    phassetLocalId: 'phid-1',
    totalBytes: 1000,
    chunkSize: 250,
    targetRelPath: '2026/04/IMG_1.heic',
    ...overrides,
  };
}

/** The columns the DTO does not carry, read straight off the row. */
function rawSession(db: Database, id: ObjectId): { updated_at: string; expires_at: string } {
  return db
    .query(`SELECT updated_at, expires_at FROM upload_sessions WHERE id = ?`)
    .get(id.toHexString()) as { updated_at: string; expires_at: string };
}

/** Pushes a session's last activity `ms` into the past. */
function backdate(db: Database, id: ObjectId, ms: number): void {
  const when = new Date(Date.now() - ms).toISOString();
  run(db, `UPDATE upload_sessions SET updated_at = ? WHERE id = ?`, when, id.toHexString());
}

describe('openOrResume — first contact', () => {
  test('opens a fresh session and dates its expiry seven days out', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    // Annotated rather than inferred: the declared result type is the contract
    // the routes compile against, so pinning it here fails the type-check if the
    // port ever returns a shape that only happens to satisfy the assertions.
    const opened: OpenOrResumeResult = await uploadSessions.openOrResume(openArgs(library), db);
    const { session, reset, alreadyComplete } = opened;

    expect(reset).toBe(false);
    expect(alreadyComplete).toBe(false);
    expect(session.state).toBe('open');
    expect(session.received_bytes).toBe(0);
    expect(session.total_bytes).toBe(1000);
    expect(session.library_id.toHexString()).toBe(library.toHexString());
    expect(session.created_at).toBeInstanceOf(Date);
    // Cleared / never-set optional fields are absent keys, not `undefined`.
    expect('maple_id' in session).toBe(false);
    expect('resolved_rel_path' in session).toBe(false);
    expect('phasset_cloud_id' in session).toBe(false);

    const raw = rawSession(handle.db, session._id);
    expect(Date.parse(raw.expires_at) - Date.parse(raw.updated_at)).toBe(7 * DAY_MS);
  });

  test('stores a cloud id when the device offers one, and ignores an empty string', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const withId = await uploadSessions.openOrResume(
      openArgs(library, { phassetCloudId: 'cloud-1' }),
      db,
    );
    const withoutId = await uploadSessions.openOrResume(
      openArgs(library, { phassetLocalId: 'phid-2', phassetCloudId: '' }),
      db,
    );

    expect(withId.session.phasset_cloud_id).toBe('cloud-1');
    expect('phasset_cloud_id' in withoutId.session).toBe(false);
  });
});

describe('openOrResume — an open session', () => {
  test('resumes an in-progress upload untouched', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const first = await uploadSessions.openOrResume(openArgs(library), db);
    await uploadSessions.recordChunk({ sessionId: first.session._id, bytesReceived: 250 }, db);
    const again = await uploadSessions.openOrResume(openArgs(library), db);

    expect(again.reset).toBe(false);
    expect(again.session._id.toHexString()).toBe(first.session._id.toHexString());
    expect(again.session.received_bytes).toBe(250);
  });

  test('resets in place when the device reports a different size or path', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const first = await uploadSessions.openOrResume(openArgs(library), db);
    await uploadSessions.recordChunk({ sessionId: first.session._id, bytesReceived: 250 }, db);
    const healed = await uploadSessions.openOrResume(
      openArgs(library, { totalBytes: 2000, chunkSize: 500 }),
      db,
    );

    expect(healed.reset).toBe(true);
    expect(healed.session._id.toHexString()).toBe(first.session._id.toHexString());
    expect(healed.session.received_bytes).toBe(0);
    expect(healed.session.total_bytes).toBe(2000);
    expect(healed.session.chunk_size).toBe(500);
    // Same session with corrected metadata — not a new attempt, so the
    // creation timestamp stands.
    expect(healed.session.created_at.getTime()).toBe(first.session.created_at.getTime());
  });

  test('a reset drops a cloud id the caller no longer has', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    await uploadSessions.openOrResume(openArgs(library, { phassetCloudId: 'cloud-1' }), db);
    const healed = await uploadSessions.openOrResume(
      openArgs(library, { targetRelPath: '2026/04/IMG_1-1.heic' }),
      db,
    );

    expect(healed.reset).toBe(true);
    expect('phasset_cloud_id' in healed.session).toBe(false);
  });

  test('rewinds a session that already holds every byte but never completed', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const first = await uploadSessions.openOrResume(openArgs(library), db);
    await uploadSessions.recordChunk({ sessionId: first.session._id, bytesReceived: 1000 }, db);
    const rewound = await uploadSessions.openOrResume(openArgs(library), db);

    expect(rewound.reset).toBe(true);
    expect(rewound.session.received_bytes).toBe(0);
    expect(rewound.session.state).toBe('open');
  });

  test('enriches a session with a cloud id that arrives mid-upload', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const first = await uploadSessions.openOrResume(openArgs(library), db);
    await uploadSessions.recordChunk({ sessionId: first.session._id, bytesReceived: 250 }, db);
    const enriched = await uploadSessions.openOrResume(
      openArgs(library, { phassetCloudId: 'cloud-9' }),
      db,
    );

    expect(enriched.reset).toBe(false);
    expect(enriched.session.phasset_cloud_id).toBe('cloud-9');
    expect(enriched.session.received_bytes).toBe(250);
    expect((await uploadSessions.findById(first.session._id, db))!.phasset_cloud_id).toBe(
      'cloud-9',
    );
  });
});

describe('openOrResume — a closed session', () => {
  test('short-circuits a completed upload of the same content', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const first = await uploadSessions.openOrResume(openArgs(library), db);
    await uploadSessions.complete({ sessionId: first.session._id, mapleId: 'maple-1' }, db);
    const retry = await uploadSessions.openOrResume(openArgs(library), db);

    expect(retry.alreadyComplete).toBe(true);
    expect(retry.reset).toBe(false);
    expect(retry.session.maple_id).toBe('maple-1');
    expect(retry.session.state).toBe('completed');
  });

  test('reopens a completed session whose content changed', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const first = await uploadSessions.openOrResume(openArgs(library), db);
    await uploadSessions.complete(
      { sessionId: first.session._id, mapleId: 'maple-1', resolvedRelPath: '2026/04/IMG_1-1.heic' },
      db,
    );
    const edited = await uploadSessions.openOrResume(openArgs(library, { totalBytes: 4096 }), db);

    expect(edited.alreadyComplete).toBe(false);
    expect(edited.reset).toBe(true);
    expect(edited.session.state).toBe('open');
    expect(edited.session.total_bytes).toBe(4096);
    // The reopen clears the previous attempt's results.
    expect('maple_id' in edited.session).toBe(false);
    expect('resolved_rel_path' in edited.session).toBe(false);
  });

  test('treats a completed session with no maple_id as corrupt and reopens it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const first = await uploadSessions.openOrResume(openArgs(library), db);
    run(
      handle.db,
      `UPDATE upload_sessions SET state = 'completed' WHERE id = ?`,
      first.session._id.toHexString(),
    );
    const retry = await uploadSessions.openOrResume(openArgs(library), db);

    expect(retry.alreadyComplete).toBe(false);
    expect(retry.reset).toBe(true);
    expect(retry.session.state).toBe('open');
  });

  test('reopens an abandoned session rather than colliding with the resume key', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const first = await uploadSessions.openOrResume(openArgs(library), db);
    await uploadSessions.recordChunk({ sessionId: first.session._id, bytesReceived: 250 }, db);
    const staleCreatedAt = new Date(Date.now() - 8 * DAY_MS).toISOString();
    run(
      handle.db,
      `UPDATE upload_sessions SET created_at = ?, updated_at = ? WHERE id = ?`,
      staleCreatedAt,
      staleCreatedAt,
      first.session._id.toHexString(),
    );
    expect(await uploadSessions.gcAbandoned(new Date(Date.now() - DAY_MS), db)).toBe(1);

    const retry = await uploadSessions.openOrResume(openArgs(library), db);

    expect(retry.reset).toBe(true);
    expect(retry.session._id.toHexString()).toBe(first.session._id.toHexString());
    expect(retry.session.state).toBe('open');
    expect(retry.session.received_bytes).toBe(0);
    // A reopen is a genuinely new attempt, so the clock restarts.
    expect(retry.session.created_at.getTime()).toBeGreaterThan(Date.parse(staleCreatedAt));
  });
});

describe('openOrResume — two devices, one iCloud photo', () => {
  test('tells the second device to back off while the first is progressing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    await uploadSessions.openOrResume(openArgs(library, { phassetCloudId: 'cloud-1' }), db);

    const rival = openArgs(library, {
      deviceId: 'device-b',
      phassetLocalId: 'phid-2',
      phassetCloudId: 'cloud-1',
    });
    const failure = await uploadSessions.openOrResume(rival, db).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(BusyElsewhereError);
    const retryAfter = (failure as BusyElsewhereError).retryAfterSeconds;
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(CROSS_DEVICE_BUSY_WINDOW_MS / 1000);
  });

  test('takes over from a stale peer and abandons every peer row', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const peer = await uploadSessions.openOrResume(
      openArgs(library, { phassetCloudId: 'cloud-1' }),
      db,
    );
    backdate(handle.db, peer.session._id, CROSS_DEVICE_BUSY_WINDOW_MS + 60_000);

    const taken = await uploadSessions.openOrResume(
      openArgs(library, {
        deviceId: 'device-b',
        phassetLocalId: 'phid-2',
        phassetCloudId: 'cloud-1',
      }),
      db,
    );

    expect(taken.session.state).toBe('open');
    expect(taken.session.device_id).toBe('device-b');
    expect((await uploadSessions.findById(peer.session._id, db))!.state).toBe('abandoned');
  });

  test('a device is never its own peer, so its own retry is not a conflict', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const args = openArgs(library, { phassetCloudId: 'cloud-1' });
    const first = await uploadSessions.openOrResume(args, db);
    const again = await uploadSessions.openOrResume(args, db);

    expect(again.session._id.toHexString()).toBe(first.session._id.toHexString());
    expect(again.reset).toBe(false);
  });

  test('a peer in another library is not a peer', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const first = new ObjectId(insertFolder(handle.db));
    const second = new ObjectId(insertFolder(handle.db));

    await uploadSessions.openOrResume(openArgs(first, { phassetCloudId: 'cloud-1' }), db);
    const elsewhere = await uploadSessions.openOrResume(
      openArgs(second, { deviceId: 'device-b', phassetCloudId: 'cloud-1' }),
      db,
    );

    expect(elsewhere.session.state).toBe('open');
  });
});

describe('recordChunk', () => {
  test('accumulates bytes and pushes the expiry out with them', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const { session } = await uploadSessions.openOrResume(openArgs(library), db);
    backdate(handle.db, session._id, DAY_MS);
    await uploadSessions.recordChunk({ sessionId: session._id, bytesReceived: 250 }, db);
    await uploadSessions.recordChunk({ sessionId: session._id, bytesReceived: 250 }, db);

    expect((await uploadSessions.findById(session._id, db))!.received_bytes).toBe(500);
    const raw = rawSession(handle.db, session._id);
    expect(Date.parse(raw.expires_at) - Date.parse(raw.updated_at)).toBe(7 * DAY_MS);
    expect(Date.parse(raw.expires_at)).toBeGreaterThan(Date.now());
  });

  test('rejects a negative byte count', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    expect(
      uploadSessions.recordChunk({ sessionId: new ObjectId(), bytesReceived: -1 }, db),
    ).rejects.toThrow(/bytesReceived must be >= 0/);
  });
});

describe('complete', () => {
  test('records the maple id and leaves the resolved path unset', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const { session } = await uploadSessions.openOrResume(openArgs(library), db);
    await uploadSessions.complete({ sessionId: session._id, mapleId: 'maple-1' }, db);

    const done = (await uploadSessions.findById(session._id, db))!;
    expect(done.state).toBe('completed');
    expect(done.maple_id).toBe('maple-1');
    expect('resolved_rel_path' in done).toBe(false);
  });

  test('stores a resolved path only when it diverges from the computed one', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const same = await uploadSessions.openOrResume(openArgs(library), db);
    await uploadSessions.complete(
      { sessionId: same.session._id, mapleId: 'm1', resolvedRelPath: '2026/04/IMG_1.heic' },
      db,
    );
    const diverged = await uploadSessions.openOrResume(
      openArgs(library, { phassetLocalId: 'phid-2' }),
      db,
    );
    await uploadSessions.complete(
      { sessionId: diverged.session._id, mapleId: 'm2', resolvedRelPath: '2026/04/IMG_1-1.heic' },
      db,
    );

    expect('resolved_rel_path' in (await uploadSessions.findById(same.session._id, db))!).toBe(
      false,
    );
    expect((await uploadSessions.findById(diverged.session._id, db))!.resolved_rel_path).toBe(
      '2026/04/IMG_1-1.heic',
    );
  });

  test('clears a stale resolved path from a prior attempt on the same key', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const { session } = await uploadSessions.openOrResume(openArgs(library), db);
    run(
      handle.db,
      `UPDATE upload_sessions SET resolved_rel_path = '2026/04/stale-7.heic' WHERE id = ?`,
      session._id.toHexString(),
    );
    await uploadSessions.complete(
      { sessionId: session._id, mapleId: 'm1', resolvedRelPath: '2026/04/IMG_1.heic' },
      db,
    );

    expect('resolved_rel_path' in (await uploadSessions.findById(session._id, db))!).toBe(false);
  });
});

describe('findById, resetForRestart, resetAllInProgressBytes and gcAbandoned', () => {
  test('findById answers null for a session that never existed', async () => {
    using handle = await createTestDatabase();
    expect(await uploadSessions.findById(new ObjectId(), testSqliteDb(handle.db))).toBeNull();
  });

  test('resetForRestart rewinds one session to offset zero', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const { session } = await uploadSessions.openOrResume(openArgs(library), db);
    await uploadSessions.recordChunk({ sessionId: session._id, bytesReceived: 500 }, db);
    await uploadSessions.resetForRestart(session._id, db);

    expect((await uploadSessions.findById(session._id, db))!.received_bytes).toBe(0);
  });

  test('resetAllInProgressBytes touches only open sessions that claim progress', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const progressing = await uploadSessions.openOrResume(openArgs(library), db);
    await uploadSessions.recordChunk(
      { sessionId: progressing.session._id, bytesReceived: 250 },
      db,
    );
    await uploadSessions.openOrResume(openArgs(library, { phassetLocalId: 'phid-untouched' }), db);
    const finished = await uploadSessions.openOrResume(
      openArgs(library, { phassetLocalId: 'phid-done' }),
      db,
    );
    await uploadSessions.recordChunk({ sessionId: finished.session._id, bytesReceived: 1000 }, db);
    await uploadSessions.complete({ sessionId: finished.session._id, mapleId: 'm1' }, db);

    expect(await uploadSessions.resetAllInProgressBytes(db)).toBe(1);
    expect((await uploadSessions.findById(progressing.session._id, db))!.received_bytes).toBe(0);
    // A completed session keeps its byte count; it is no longer resumable.
    expect((await uploadSessions.findById(finished.session._id, db))!.received_bytes).toBe(1000);
  });

  test('gcAbandoned sweeps only open sessions older than the cutoff', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const library = new ObjectId(insertFolder(handle.db));

    const stale = await uploadSessions.openOrResume(openArgs(library), db);
    backdate(handle.db, stale.session._id, 8 * DAY_MS);
    const fresh = await uploadSessions.openOrResume(
      openArgs(library, { phassetLocalId: 'phid-fresh' }),
      db,
    );

    expect(await uploadSessions.gcAbandoned(new Date(Date.now() - 7 * DAY_MS), db)).toBe(1);
    expect((await uploadSessions.findById(stale.session._id, db))!.state).toBe('abandoned');
    expect((await uploadSessions.findById(fresh.session._id, db))!.state).toBe('open');
    // Already abandoned — a second sweep has nothing to do.
    expect(await uploadSessions.gcAbandoned(new Date(Date.now() - 7 * DAY_MS), db)).toBe(0);
  });
});
