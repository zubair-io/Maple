/**
 * A handle that records which reads a caller issued together (#4503).
 *
 * Every read is answered on the next macrotask, so reads issued before the caller awaits share a
 * wave and a read issued after an await starts the next one. The number of waves is the number of
 * sequential trips a request makes through the pool's reader queue, which is the cost a test
 * pinning a round-trip shape cares about. A read sent through the pool's bulk lane is recorded
 * with a `bulk: ` prefix, so a test can also pin which lane each statement took.
 */

import type { SqliteDb } from '../repos/db-handle.ts';

export interface ReadWaves {
  handle: SqliteDb & { readBulk: SqliteDb['read'] };
  /** The SQL of each wave, in issue order. */
  waves: string[][];
}

export function recordReadWaves(inner: SqliteDb): ReadWaves {
  const waves: string[][] = [];
  const state = { open: false };
  const record = async (label: string, sql: string) => {
    if (!state.open) {
      waves.push([]);
      state.open = true;
      setTimeout(() => (state.open = false), 0);
    }
    waves[waves.length - 1]!.push(label);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return sql;
  };
  const handle: ReadWaves['handle'] = {
    read: async (sql, params) => inner.read(await record(sql, sql), params),
    readBulk: async (sql, params) => inner.read(await record(`bulk: ${sql}`, sql), params),
    write: (sql, params) => inner.write(sql, params),
    transaction: (statements) => inner.transaction(statements),
  };
  return { handle, waves };
}
