/**
 * #4420 — every Meilisearch call that can sit on a user request (boot health,
 * the connection test, the trash route's tombstone) is bounded by the
 * per-request timeout; background bulk uploads are not.
 */

import { describe, expect, it } from 'bun:test';
import { createMeilisearchClient, type MeilisearchAssetDoc } from './meilisearch-client.ts';

const TEST_REQUEST_TIMEOUT_MS = 50;

const BACKGROUND_DOC: MeilisearchAssetDoc = {
  id: 'abc123',
  searchBlob: 'albany ny museum',
  folderId: '0123456789abcdef01234567',
  capturedAt: null,
  deletedAt: null,
};

interface RecordedRequest {
  url: string;
  signal: AbortSignal | null;
}

/** A fetch that only ever settles by rejecting when its signal aborts — a
 * sidecar that accepted the connection and then went silent. */
function hangingFetch(): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? null;
    requests.push({ url: String(input), signal });
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason));
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function hungClient(fetchImpl: typeof fetch) {
  return createMeilisearchClient({
    url: 'http://meili.local:7700',
    fetchImpl,
    requestTimeoutMs: TEST_REQUEST_TIMEOUT_MS,
  });
}

describe('Meilisearch request timeout', () => {
  it('health() reports unreachable instead of hanging', async () => {
    const { fetchImpl } = hangingFetch();
    expect(await hungClient(fetchImpl).health()).toBe(false);
  });

  it('the trash-path tombstone returns instead of hanging', async () => {
    const { fetchImpl, requests } = hangingFetch();
    await hungClient(fetchImpl).tombstone('abc123');
    expect(requests[0]?.signal?.aborted).toBe(true);
  });

  it('search() rejects so the route can fall back', async () => {
    const { fetchImpl } = hangingFetch();
    await expect(hungClient(fetchImpl).search('museum')).rejects.toThrow();
  });

  it('leaves background bulk uploads unbounded', async () => {
    const { fetchImpl, requests } = hangingFetch();
    void hungClient(fetchImpl).upsertBatchOrThrow!([BACKGROUND_DOC]);
    await Bun.sleep(TEST_REQUEST_TIMEOUT_MS * 2);
    expect(requests[0]?.signal).toBeNull();
  });
});
