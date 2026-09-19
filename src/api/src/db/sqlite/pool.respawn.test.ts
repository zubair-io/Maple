/**
 * Bringing a dead reader back (#3782).
 *
 * The pool already routed around a dead reader; nothing brought it back, so the
 * first crash halved read capacity and the second took reads down until someone
 * restarted the process by hand. That is not the 1/N loss it sounds like — a
 * pool of N tolerates N−1 sustained long reads and collapses at N, so on the
 * pool of two that shipped, one dead thread took the request-path read from
 * 203,541 completions in four seconds to 32 (`scripts/sqlite-bench/reader-pool.ts`).
 *
 * What is pinned here is the policy, not just the mechanism: that a reader
 * comes back, that one which cannot open the database is given up on rather
 * than retried for the life of the process, that a reader which recovers and
 * does real work starts its next failure with a fresh budget, and that none of
 * this weakens the two behaviours the pool already had — fail-closed startup
 * and an actionable rejection when every reader is gone.
 *
 * A real thread cannot be asked to die on cue, so these drive {@link FakeWorker}
 * exactly as `pool.resilience.test.ts` does, and shorten the backoff ladder so
 * the end of it can be reached without a twelve-second test.
 */

import { describe, expect, test } from 'bun:test';

import { SqlitePool, type ReaderRespawnEvent } from './pool.ts';
import { FakeWorker, fakeWorkers } from './pool.test-helpers.ts';
import type { SqliteWorkerRole } from './protocol.ts';

/** A ladder whose every rung is immediate — the timings are not what is under test. */
const FAST_LADDER = [1, 1, 1, 1] as const;

/** Enough for a `postMessage` round trip, short enough to keep the suite fast. */
const SHORT_TIMEOUT_MS = 30;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Polls until `predicate` holds, or fails the test rather than hanging. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(2);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Readers only — `spawned` also holds the writer, which is always first. */
function readerWorkers(spawned: readonly FakeWorker[]): FakeWorker[] {
  return spawned.filter((worker) => worker.role === 'reader');
}

/**
 * A spawn function that records what it made and can start a chosen worker
 * silent, picked by role and by how many of that role came before it.
 *
 * Counting per role is what lets a test say "the second reader ever spawned",
 * which spans the initial open and the respawns after it — the two staging
 * questions here are "which reader fails its handshake during startup" and
 * "which respawn attempt fails", and both are that same counter.
 */
function countedSpawn(
  spawned: FakeWorker[],
  silentWhen: (role: SqliteWorkerRole, nth: number) => boolean,
): (role: SqliteWorkerRole) => Worker {
  const counts = { writer: 0, reader: 0 };
  return (role: SqliteWorkerRole) => {
    const worker = new FakeWorker(role);
    if (silentWhen(role, counts[role]++)) worker.goSilent();
    spawned.push(worker);
    return worker.asWorker();
  };
}

describe('a reader that dies comes back', () => {
  test('the slot is respawned and serves reads again', async () => {
    const { spawned, spawn } = fakeWorkers();
    const events: ReaderRespawnEvent[] = [];
    const pool = await SqlitePool.open({
      path: '/unused',
      readers: 2,
      spawnWorker: spawn,
      respawnDelaysMs: FAST_LADDER,
      onReaderRespawn: (event) => events.push(event),
    });
    try {
      // spawned is [writer, reader 0, reader 1].
      spawned[1]?.exit();
      await until(() => pool.stats().readers[0]?.alive === true, 'reader 0 to come back');

      const rows = await pool.read('SELECT 1');
      const stats = pool.stats();
      const replacement = readerWorkers(spawned).at(-1);

      expect(rows).toEqual([]);
      // A genuinely new thread, handshaked — not the corpse marked alive again.
      expect(readerWorkers(spawned)).toHaveLength(3);
      expect(replacement?.received.filter((request) => request.kind === 'open')).toHaveLength(1);
      expect(stats.readers.map((reader) => reader.alive)).toEqual([true, true]);
      expect(stats.readers[0]?.restarts).toBe(1);
      expect(events).toEqual([
        { reader: 0, attempt: 1, outcome: 'respawned', reason: 'worker exited' },
      ]);
    } finally {
      pool.close();
    }
  });

  test('reads recover after every reader has died, with no process restart', async () => {
    const { spawned, spawn } = fakeWorkers();
    const pool = await SqlitePool.open({
      path: '/unused',
      readers: 2,
      spawnWorker: spawn,
      respawnDelaysMs: FAST_LADDER,
    });
    try {
      for (const worker of readerWorkers(spawned)) worker.exit();

      // The floor the pool already had, and must keep: while there is genuinely
      // nothing to run on, a read says so by name rather than hanging.
      const duringOutage = await pool.read('SELECT 1').then(
        () => null,
        (e: Error) => e,
      );
      await until(
        () => pool.stats().readers.every((reader) => reader.alive),
        'both readers to come back',
      );
      const afterRecovery = await pool.read('SELECT 1');

      expect(duringOutage?.message).toContain('every reader worker');
      expect(duringOutage?.message).toContain('/unused');
      // The property the ticket is about: this pool served a read again without
      // anything restarting the process.
      expect(afterRecovery).toEqual([]);
      expect(pool.stats().readers.map((reader) => reader.restarts)).toEqual([1, 1]);
    } finally {
      pool.close();
    }
  });

  test('a reader that recovered and did work starts its next failure at attempt 1', async () => {
    const { spawned, spawn } = fakeWorkers();
    const events: ReaderRespawnEvent[] = [];
    const pool = await SqlitePool.open({
      path: '/unused',
      readers: 1,
      spawnWorker: spawn,
      respawnDelaysMs: FAST_LADDER,
      onReaderRespawn: (event) => events.push(event),
    });
    try {
      for (let death = 0; death < 3; death += 1) {
        readerWorkers(spawned).at(-1)?.exit();
        await until(() => pool.stats().readers[0]?.alive === true, `respawn ${death + 1}`);
        // Doing real work is what proves the database is openable and the
        // thread can run, which is what earns the reset.
        await pool.read('SELECT 1');
      }

      // Three separate transient deaths, never a climbing ladder — without the
      // reset the third would be attempt 3 and the fifth would retire a
      // perfectly healthy reader.
      expect(events.map((event) => event.attempt)).toEqual([1, 1, 1]);
      expect(events.every((event) => event.outcome === 'respawned')).toBe(true);
      expect(pool.stats().readers[0]?.restarts).toBe(3);
    } finally {
      pool.close();
    }
  });
});

describe('a reader that dies during startup', () => {
  test('is respawned, not returned dead in a pool that never heard about it', async () => {
    // The window is wider than the instant before the constructor runs.
    // `Promise.all` waits for every reader, so a reader whose handshake landed
    // first sits there live and idle for the whole of the rest of startup. The
    // second reader is spawned silent, so the open stays parked on it while the
    // first one dies — and that death calls a hook which resolves to a pool
    // that does not exist yet and is dropped on the floor.
    const spawned: FakeWorker[] = [];
    const events: ReaderRespawnEvent[] = [];
    const spawn = countedSpawn(spawned, (role, nth) => role === 'reader' && nth === 1);

    const opening = SqlitePool.open({
      path: '/unused',
      readers: 2,
      spawnWorker: spawn,
      respawnDelaysMs: FAST_LADDER,
      onReaderRespawn: (event) => events.push(event),
    });
    // Let the writer and the first reader finish handshaking. The open cannot
    // have returned: the silent reader has not answered.
    await sleep(5);
    expect(readerWorkers(spawned)).toHaveLength(2);

    readerWorkers(spawned)[0]?.exit();
    readerWorkers(spawned)[1]?.deliverLateReply();

    const pool = await opening;
    try {
      await until(() => pool.stats().readers[0]?.alive === true, 'reader 0 to be swept up');
      const rows = await pool.read('SELECT 1');

      expect(rows).toEqual([]);
      expect(pool.stats().readers.map((reader) => reader.alive)).toEqual([true, true]);
      expect(pool.stats().readers[0]?.restarts).toBe(1);
      expect(events.map((event) => event.outcome)).toEqual(['respawned']);
    } finally {
      pool.close();
    }
  });

  test('a reader that never completes its handshake still fails the open', async () => {
    // The other side of the line: the sweep must not turn a fail-closed startup
    // into a pool that quietly respawns its way up. Before the handshake there
    // is no pool member to bring back.
    const { spawn } = fakeWorkers({ silent: true });
    const error = await SqlitePool.open({
      path: '/unused',
      readers: 1,
      spawnWorker: spawn,
      requestTimeoutMs: SHORT_TIMEOUT_MS,
      respawnDelaysMs: FAST_LADDER,
    }).then(
      (pool) => {
        pool.close();
        return null;
      },
      (e: Error) => e,
    );

    expect(error?.message).toContain('could not open');
  });
});

describe('what a respawn event reports', () => {
  test('a recovery names the death, not whatever the failed attempt before it hit', async () => {
    // Reader spawn 0 opens the pool, spawn 1 is the respawn attempt that fails
    // its handshake, spawn 2 is the one that works.
    const spawned: FakeWorker[] = [];
    const events: ReaderRespawnEvent[] = [];
    const spawn = countedSpawn(spawned, (role, nth) => role === 'reader' && nth === 1);
    const pool = await SqlitePool.open({
      path: '/unused',
      readers: 1,
      spawnWorker: spawn,
      requestTimeoutMs: SHORT_TIMEOUT_MS,
      respawnDelaysMs: FAST_LADDER,
      onReaderRespawn: (event) => events.push(event),
    });
    try {
      readerWorkers(spawned)[0]?.exit();
      await until(() => pool.stats().readers[0]?.alive === true, 'the second attempt to land');

      // Two different questions, and folding them into one variable answered
      // the second one wrong: an operator reading "respawned, reason: could not
      // open" would be looking for a database fault that never happened.
      expect(events.map((event) => event.outcome)).toEqual(['failed', 'respawned']);
      expect(events[0]?.reason).toContain('could not open');
      expect(events[1]?.reason).toBe('worker exited');
    } finally {
      pool.close();
    }
  });
});

describe('a reader that cannot open the database', () => {
  /**
   * Answers the initial open, then hands out workers that never reply — the
   * shape of a database that has become unopenable while the process ran.
   */
  function spawnThatBreaksAfterStartup(spawned: FakeWorker[]): {
    spawn: (role: SqliteWorkerRole) => Worker;
    breakIt: () => void;
  } {
    let broken = false;
    return {
      breakIt: () => {
        broken = true;
      },
      spawn: (role: SqliteWorkerRole) => {
        const worker = new FakeWorker(role);
        if (broken) worker.goSilent();
        spawned.push(worker);
        return worker.asWorker();
      },
    };
  }

  test('is retired after the ladder rather than retried for the life of the process', async () => {
    const spawned: FakeWorker[] = [];
    const events: ReaderRespawnEvent[] = [];
    const { spawn, breakIt } = spawnThatBreaksAfterStartup(spawned);
    const pool = await SqlitePool.open({
      path: '/unused',
      readers: 1,
      spawnWorker: spawn,
      requestTimeoutMs: SHORT_TIMEOUT_MS,
      respawnDelaysMs: FAST_LADDER,
      onReaderRespawn: (event) => events.push(event),
    });
    try {
      breakIt();
      readerWorkers(spawned).at(-1)?.exit();
      await until(
        () => events.some((event) => event.outcome === 'retired'),
        'the reader to be retired',
      );
      const spawnsAtRetirement = spawned.length;
      // Well past the whole (shortened) ladder several times over.
      await sleep(300);
      const readError = await pool.read('SELECT 1').then(
        () => null,
        (e: Error) => e,
      );

      // One attempt per rung and not one more, then nothing — the failure this
      // test exists for is an unbounded respawn loop, which would keep climbing.
      expect(events.filter((event) => event.outcome === 'failed')).toHaveLength(FAST_LADDER.length);
      expect(events.at(-1)?.outcome).toBe('retired');
      // A failed attempt reports its own error rather than the death that
      // started the ladder — they are different questions, and the one an
      // operator needs here is why it could not come back.
      expect(events[0]?.reason).toContain('could not open');
      expect(events.at(-1)?.reason).toContain('could not open');
      expect(spawned).toHaveLength(spawnsAtRetirement);
      // The operator signal the ticket asked to keep: gone, never came back,
      // and the read says which database it could not run on.
      expect(pool.stats().readers[0]?.alive).toBe(false);
      expect(pool.stats().readers[0]?.restarts).toBe(0);
      expect(readError?.message).toContain('every reader worker');
    } finally {
      pool.close();
    }
  }, 10_000);
});

describe('what respawn deliberately does not do', () => {
  test('the writer is not respawned', async () => {
    const { spawned, spawn } = fakeWorkers();
    const pool = await SqlitePool.open({
      path: '/unused',
      readers: 1,
      spawnWorker: spawn,
      respawnDelaysMs: FAST_LADDER,
    });
    try {
      spawned[0]?.exit();
      await sleep(100);

      const writeError = await pool.write('INSERT INTO t VALUES (1)').then(
        () => null,
        (e: Error) => e,
      );

      // Single by design. A resurrected writer would start accepting work as
      // though the call ordering its rejected callers were promised still held.
      expect(spawned.filter((worker) => worker.role === 'writer')).toHaveLength(1);
      expect(writeError?.message).toContain('writer');
      expect(pool.stats().writer.alive).toBe(false);
    } finally {
      pool.close();
    }
  });

  test('close during a respawn leaves no thread behind', async () => {
    const { spawned, spawn } = fakeWorkers();
    const pool = await SqlitePool.open({
      path: '/unused',
      readers: 1,
      spawnWorker: spawn,
      // Long enough that close lands while the ladder is still sleeping.
      respawnDelaysMs: [200],
    });
    readerWorkers(spawned).at(-1)?.exit();
    pool.close();
    await sleep(400);

    // A pool that has been closed must not spawn a thread afterwards, and must
    // certainly not leave one holding the database file open.
    expect(readerWorkers(spawned)).toHaveLength(1);
    expect(spawned.every((worker) => worker.terminated)).toBe(true);
  });

  test('a throwing callback does not disable respawn for that slot', async () => {
    const { spawned, spawn } = fakeWorkers();
    const pool = await SqlitePool.open({
      path: '/unused',
      readers: 1,
      spawnWorker: spawn,
      respawnDelaysMs: FAST_LADDER,
      onReaderRespawn: () => {
        throw new Error('the logger blew up');
      },
    });
    try {
      // Escaping mid-ladder would leave the slot's `inFlight` set forever, so a
      // mistake in a log line would quietly cost the pool a reader for good.
      readerWorkers(spawned).at(-1)?.exit();
      await until(() => pool.stats().readers[0]?.alive === true, 'the first respawn');
      await pool.read('SELECT 1');
      readerWorkers(spawned).at(-1)?.exit();
      await until(() => pool.stats().readers[0]?.restarts === 2, 'the second respawn');

      expect(pool.stats().readers[0]?.alive).toBe(true);
    } finally {
      pool.close();
    }
  });
});
