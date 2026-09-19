/**
 * What the pool does when a worker misbehaves.
 *
 * The three failures pinned here are the ones that turn a local fault into a
 * global one: a reader that dies and then attracts every subsequent read
 * because a dead handle reports an empty queue; a reply that never arrives and
 * parks its caller for the life of the process; and a worker that raises an
 * error without exiting, which must still be terminatable. None of them can be
 * staged with a real thread on cue, so these tests drive {@link FakeWorker}.
 *
 * Test shape note — round trips first, assertions afterwards, matching the
 * other suites in this directory.
 */

import { describe, expect, test } from 'bun:test';

import { SqlitePool } from './pool.ts';
import { fakeWorkers } from './pool.test-helpers.ts';

/** Enough for a `postMessage` round trip, short enough to keep the suite fast. */
const SHORT_TIMEOUT_MS = 50;

describe('SqlitePool reader liveness', () => {
  test('a dead reader is skipped rather than preferred for its empty queue', async () => {
    const { spawned, spawn } = fakeWorkers();
    const pool = await SqlitePool.open({ path: '/unused', readers: 2, spawnWorker: spawn });
    try {
      const [, first, second] = spawned;
      first?.exit();

      const rows = await Promise.all([pool.read('SELECT 1'), pool.read('SELECT 2')]);
      const stats = pool.stats();

      // A dead handle's `inFlight` is zero forever, so routing on depth alone
      // would send every read into the corpse and reject all of them.
      expect(rows).toEqual([[], []]);
      expect(second?.received.filter((request) => request.kind === 'read')).toHaveLength(2);
      expect(first?.received.filter((request) => request.kind === 'read')).toHaveLength(0);
      // An operator needs to see the difference between idle and gone.
      expect(stats.readers.map((reader) => reader.alive)).toEqual([false, true]);
    } finally {
      pool.close();
    }
  });

  test('losing every reader rejects reads by name and leaves writes working', async () => {
    const { spawned, spawn } = fakeWorkers();
    const pool = await SqlitePool.open({ path: '/unused', readers: 2, spawnWorker: spawn });
    try {
      for (const worker of spawned.filter((candidate) => candidate.role === 'reader')) {
        worker.exit();
      }

      const readError = await pool.read('SELECT 1').then(
        () => null,
        (e: Error) => e,
      );
      const write = await pool.write('INSERT INTO t VALUES (1)');

      expect(readError?.message).toContain('every reader worker');
      expect(write).toEqual({ changes: 0, lastInsertRowid: 0 });
    } finally {
      pool.close();
    }
  });
});

describe('SqlitePool request timeout', () => {
  test('a dropped reply rejects its caller instead of hanging', async () => {
    const { spawned, spawn } = fakeWorkers();
    const pool = await SqlitePool.open({
      path: '/unused',
      readers: 1,
      spawnWorker: spawn,
      requestTimeoutMs: SHORT_TIMEOUT_MS,
    });
    try {
      spawned[1]?.goSilent();

      const started = Date.now();
      const error = await pool.read('SELECT 1').then(
        () => null,
        (e: Error) => e,
      );
      const elapsed = Date.now() - started;
      const stats = pool.stats();

      expect(error?.message).toContain('did not answer request');
      expect(elapsed).toBeLessThan(5_000);
      // The orphan must not keep counting against the worker: a permanently
      // inflated `inFlight` would bias routing away from a healthy reader.
      expect(stats.readers[0]?.inFlight).toBe(0);
      expect(stats.readers[0]?.failed).toBe(1);
      expect(stats.inFlight).toBe(0);
    } finally {
      pool.close();
    }
  });

  test('a worker that never completes the handshake fails the open', async () => {
    const { spawn } = fakeWorkers({ silent: true });
    const error = await SqlitePool.open({
      path: '/unused',
      spawnWorker: spawn,
      requestTimeoutMs: SHORT_TIMEOUT_MS,
    }).then(
      (pool) => {
        pool.close();
        return null;
      },
      (e: Error) => e,
    );

    expect(error?.message).toContain('writer worker could not open');
    expect(error?.message).toContain('did not answer request');
  });

  test('a late reply to a timed-out request is ignored, not mistaken for another', async () => {
    const { spawned, spawn } = fakeWorkers();
    const pool = await SqlitePool.open({
      path: '/unused',
      readers: 1,
      spawnWorker: spawn,
      requestTimeoutMs: SHORT_TIMEOUT_MS,
    });
    try {
      const reader = spawned[1];
      reader?.goSilent();
      const timedOut = await pool.read('SELECT 1').then(
        () => null,
        (e: Error) => e,
      );
      // The worker wakes up and answers the request the pool has given up on.
      reader?.deliverLateReply();
      const afterLateReply = await pool.read('SELECT 2');
      const stats = pool.stats();

      expect(timedOut?.message).toContain('did not answer request');
      expect(afterLateReply).toEqual([]);
      expect(stats.readers[0]?.inFlight).toBe(0);
    } finally {
      pool.close();
    }
  });
});

describe('SqlitePool termination', () => {
  test('a worker that errored without exiting is still terminated by close()', async () => {
    const { spawned, spawn } = fakeWorkers();
    const pool = await SqlitePool.open({ path: '/unused', readers: 1, spawnWorker: spawn });
    const writer = spawned[0];

    // An uncaught throw inside the worker's message handler raises `error`
    // without necessarily exiting the thread — which still holds the database
    // file open, and still has to be killed.
    writer?.raise();
    pool.close();

    expect(spawned.every((worker) => worker.terminated)).toBe(true);
  });
});
