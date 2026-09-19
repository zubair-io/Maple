/**
 * Registry — cache integration tests.
 *
 * The registry is a thin cache over the `stage_handlers` table, so the tests
 * round-trip against a real database. `resolve()` reaches the process-wide
 * handle with no override, so each test installs its own.
 */

import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import {
  createLiveTestDatabase,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { resolve, __resetForTests } from './registry.ts';

let live: LiveTestDatabase;

function insertHandler(args: {
  impl: 'builtin' | 'http';
  url?: string | null;
  timeoutMs?: number | null;
  enabled: boolean;
}): void {
  run(
    live.db,
    `INSERT INTO stage_handlers (stage, impl, url, timeout_ms, enabled) VALUES ('ai', ?, ?, ?, ?)`,
    args.impl,
    args.url ?? null,
    args.timeoutMs ?? null,
    args.enabled ? 1 : 0,
  );
}

describe('registry.resolve', () => {
  beforeEach(async () => {
    live = await createLiveTestDatabase();
    __resetForTests();
  });

  afterEach(() => {
    __resetForTests();
    live.close();
  });

  it('returns the builtin descriptor when no row exists', async () => {
    const r = await resolve('ai');
    expect(r.impl).toBe('builtin');
    expect(r.url).toBeNull();
  });

  it('returns the http descriptor when an enabled row exists', async () => {
    insertHandler({
      impl: 'http',
      url: 'https://example.invalid/ai',
      timeoutMs: 5000,
      enabled: true,
    });

    const r = await resolve('ai');
    expect(r.impl).toBe('http');
    expect(r.url).toBe('https://example.invalid/ai');
    expect(r.timeoutMs).toBe(5000);
  });

  it('treats disabled rows as if they did not exist', async () => {
    insertHandler({ impl: 'http', url: 'https://example.invalid/ai', enabled: false });

    const r = await resolve('ai');
    expect(r.impl).toBe('builtin');
  });

  it('caches: changing the row after the first resolve does not affect the second', async () => {
    // Behavioural cache check that doesn't rely on internal monkey-patching:
    // 1. Insert row A and resolve — populates the cache.
    // 2. Mutate the row to value B.
    // 3. Resolve again WITHOUT calling refresh() — must still see A.
    // 4. refresh(), resolve again — must see B.
    insertHandler({ impl: 'http', url: 'https://example.invalid/cache-A', enabled: true });

    const first = await resolve('ai');
    expect(first.url).toBe('https://example.invalid/cache-A');

    run(
      live.db,
      `UPDATE stage_handlers SET url = ? WHERE stage = 'ai'`,
      'https://example.invalid/cache-B',
    );

    const second = await resolve('ai');
    expect(second.url).toBe('https://example.invalid/cache-A');

    __resetForTests();
    const third = await resolve('ai');
    expect(third.url).toBe('https://example.invalid/cache-B');
  });
});
