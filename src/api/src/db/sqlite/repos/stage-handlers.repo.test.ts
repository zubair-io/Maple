/**
 * `stage_handlers`: one read, and the two things the registry's projection
 * depends on — a disabled row being invisible, and an unset column arriving as
 * an absent key rather than a null.
 */

import { describe, expect, test } from 'bun:test';
import { createTestDatabase, run } from '../test-sqlite.test-helpers.ts';
import { testSqliteDb } from './assets.test-helpers.ts';
import { listEnabledStageHandlers } from './stage-handlers.repo.ts';
import type { Database } from 'bun:sqlite';

function insertHandler(
  db: Database,
  args: {
    stage: string;
    impl?: 'builtin' | 'http';
    url?: string | null;
    timeoutMs?: number | null;
    enabled?: boolean;
  },
): void {
  run(
    db,
    `INSERT INTO stage_handlers (stage, impl, url, timeout_ms, enabled) VALUES (?, ?, ?, ?, ?)`,
    args.stage,
    args.impl ?? 'http',
    args.url ?? null,
    args.timeoutMs ?? null,
    args.enabled === false ? 0 : 1,
  );
}

describe('listEnabledStageHandlers', () => {
  test('is empty when no stage has been overridden', async () => {
    using handle = await createTestDatabase();
    expect(await listEnabledStageHandlers(testSqliteDb(handle.db))).toEqual([]);
  });

  test('returns an enabled http override with its url and timeout', async () => {
    using handle = await createTestDatabase();
    insertHandler(handle.db, { stage: 'ai', url: 'http://handler.local', timeoutMs: 5000 });
    expect(await listEnabledStageHandlers(testSqliteDb(handle.db))).toEqual([
      { stage: 'ai', impl: 'http', url: 'http://handler.local', timeout_ms: 5000, enabled: true },
    ]);
  });

  test('omits a disabled row, which is treated as if it did not exist', async () => {
    using handle = await createTestDatabase();
    insertHandler(handle.db, { stage: 'ai', url: 'http://off', enabled: false });
    expect(await listEnabledStageHandlers(testSqliteDb(handle.db))).toEqual([]);
  });

  test('a builtin row carries no url or timeout keys at all', async () => {
    using handle = await createTestDatabase();
    insertHandler(handle.db, { stage: 'thumb', impl: 'builtin' });
    const rows = await listEnabledStageHandlers(testSqliteDb(handle.db));
    // The registry projects on `typeof doc.url === 'string'`, so absence and
    // null behave alike — but absence is what the document held.
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['enabled', 'impl', 'stage']);
  });
});
