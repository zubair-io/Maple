/**
 * Unit tests for the per-call `tombstoneBatchOrThrow` timeout override
 * (#2359). Kept in its own file rather than folded into
 * `meilisearch-client.test.ts`, which is already at the file-size budget
 * warning threshold.
 *
 * Covers the plumbing from a per-call `timeoutMs` argument down into
 * `waitForMeilisearchTask`'s deadline computation: a short override must
 * make the wait fail fast even when the client's own configured
 * `taskTimeoutMs` (the bulk-batch default) is much longer, and omitting the
 * override must keep using the client's configured timeout.
 */

import { describe, it, expect } from 'bun:test';
import { ASSETS_INDEX, createMeilisearchClient } from './meilisearch-client.ts';
import { makeFakeFetch } from './meilisearch-test-harness.ts';

describe('Meilisearch client — tombstoneBatchOrThrow timeout override (#2359)', () => {
  it('a short per-call timeoutMs overrides the client-configured taskTimeoutMs and fails fast', async () => {
    const { fetchImpl } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/documents`,
          status: 202,
          body: { taskUid: 7 },
        },
        {
          // Task never finishes — stays "processing" on every poll — so the
          // wait can only resolve by hitting the timeout.
          method: 'GET',
          pathPrefix: '/tasks/7',
          body: { uid: 7, status: 'processing' },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
      taskPollIntervalMs: 5,
      // The client-configured (bulk-batch) default: 10 minutes. If the
      // per-call override below didn't reach `waitForMeilisearchTask`, this
      // test would hang for 10 real minutes instead of failing in
      // milliseconds.
      taskTimeoutMs: 10 * 60 * 1000,
    });

    const startedMs = Date.now();
    await expect(client.tombstoneBatchOrThrow!(['abc123'], 30)).rejects.toThrow(/timed out/);
    expect(Date.now() - startedMs).toBeLessThan(2_000);
  });

  it('falls back to the client-configured timeout when no override is passed', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/documents`,
          status: 202,
          body: { taskUid: 8 },
        },
        {
          method: 'GET',
          pathPrefix: '/tasks/8',
          body: { uid: 8, status: 'succeeded' },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
      taskPollIntervalMs: 5,
    });

    await expect(client.tombstoneBatchOrThrow!(['abc123'])).resolves.toBeUndefined();
    expect(calls.some((c) => c.url.includes('/tasks/8'))).toBe(true);
  });
});
