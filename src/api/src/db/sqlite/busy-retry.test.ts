/**
 * The cross-process busy retry, and the import it must never grow (#3752).
 */

import { describe, expect, test } from 'bun:test';
import { isBusyError, retryOnBusy } from './busy-retry.ts';

function busy(): Error {
  return new Error('SQLITE_BUSY: database is locked (5)');
}

describe('isBusyError', () => {
  test('recognises lock contention in both spellings, and nothing else', () => {
    // The pool's spelling: the driver's error flattened to text with the code
    // appended, because an Error does not clone across the worker boundary.
    expect(isBusyError(busy())).toBe(true);
    expect(isBusyError(new Error('SQLITE_LOCKED: database table is locked'))).toBe(true);
    // bun:sqlite's own wording, which the importer and the tests see directly.
    expect(isBusyError(new Error('database is locked'))).toBe(true);

    // Everything that would fail identically on a retry.
    expect(isBusyError(new Error('CHECK constraint failed: maple_id'))).toBe(false);
    expect(isBusyError(new Error('sqlite pool: pool for /tmp/x is closed'))).toBe(false);
    expect(isBusyError('not an error at all')).toBe(false);
  });
});

describe('retryOnBusy', () => {
  test('returns the first answer when there is no contention', async () => {
    let calls = 0;
    const value = await retryOnBusy(() => {
      calls += 1;
      return Promise.resolve('ok');
    });
    expect(value).toBe('ok');
    expect(calls).toBe(1);
  });

  test('runs the attempt again while the writer is locked, and returns when it frees', async () => {
    let calls = 0;
    const value = await retryOnBusy(() => {
      calls += 1;
      return calls < 3 ? Promise.reject(busy()) : Promise.resolve('landed');
    });
    expect(value).toBe('landed');
    expect(calls).toBe(3);
  });

  test('gives up rather than looping forever, and rethrows what it last saw', async () => {
    let calls = 0;
    const failure = await retryOnBusy(() => {
      calls += 1;
      return Promise.reject(busy());
    }).then(
      () => null,
      (err: unknown) => err,
    );

    // The ladder is three retries, so four attempts in total. A lock held for
    // longer than that is a real problem and must surface.
    expect(calls).toBe(4);
    expect(String(failure)).toContain('SQLITE_BUSY');
  });

  test('does not retry a failure a retry cannot fix', async () => {
    let calls = 0;
    const failure = await retryOnBusy(() => {
      calls += 1;
      return Promise.reject(new Error('CHECK constraint failed: maple_id'));
    }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(calls).toBe(1);
    expect(String(failure)).toContain('CHECK constraint failed');
  });
});

describe('the module graph', () => {
  test('pulls in no logger, because the pool that imports it is loaded in a Worker', async () => {
    // `pool.ts` imports this module, and the clustering worker reaches
    // `pool.ts` through `worker-db.ts` — so anything imported here is loaded
    // inside a Worker thread. Importing pino there wedges the thread: the
    // worker never answers its first message. A one-line log.warn in this file
    // took `people.cluster-pool.test.ts` from 214 ms to a hard timeout.
    const source = await Bun.file(new URL('./busy-retry.ts', import.meta.url)).text();
    expect(source).not.toMatch(/from '.*\/log\.ts'/);
  });
});
