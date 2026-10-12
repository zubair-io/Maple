/**
 * A handle that records which reads a caller issued together (#4503).
 *
 * Every read is answered on the next macrotask, so reads issued before the caller awaits share a
 * wave and a read issued after an await starts the next one. The number of waves is the number of
 * sequential trips a request makes through the pool's reader queue, which is the cost a test
 * pinning a round-trip shape cares about.
 */

import type { SqliteDb } from '../repos/db-handle.ts';

export interface ReadWaves {
  handle: SqliteDb;
  /** The SQL of each wave, in issue order. */
  waves: string[][];
}

export function recordReadWaves(inner: SqliteDb): ReadWaves {
  const waves: string[][] = [];
  const state = { open: false };
  const handle: SqliteDb = {
    async read(sql, params) {
      if (!state.open) {
        waves.push([]);
        state.open = true;
        setTimeout(() => (state.open = false), 0);
      }
      waves[waves.length - 1]!.push(sql);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return inner.read(sql, params);
    },
    write: (sql, params) => inner.write(sql, params),
    transaction: (statements) => inner.transaction(statements),
  };
  return { handle, waves };
}
