/**
 * `search()` behavior of the Meilisearch client — split from
 * `meilisearch-client.test.ts` for the file-size budget (#2311 headroom).
 * Same fake-fetch harness; no real Meilisearch required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  ASSETS_INDEX,
  createMeilisearchClient,
  MeilisearchSearchError,
} from './meilisearch-client.ts';
import { makeFakeFetch } from './meilisearch-test-harness.ts';

const PRIOR_URL = process.env.MAPLE_MEILISEARCH_URL;
const PRIOR_KEY = process.env.MAPLE_MEILISEARCH_API_KEY;

beforeEach(() => {
  delete process.env.MAPLE_MEILISEARCH_URL;
  delete process.env.MAPLE_MEILISEARCH_API_KEY;
});

afterEach(() => {
  if (PRIOR_URL === undefined) delete process.env.MAPLE_MEILISEARCH_URL;
  else process.env.MAPLE_MEILISEARCH_URL = PRIOR_URL;
  if (PRIOR_KEY === undefined) delete process.env.MAPLE_MEILISEARCH_API_KEY;
  else process.env.MAPLE_MEILISEARCH_API_KEY = PRIOR_KEY;
});

describe('Meilisearch client — search()', () => {
  it('search() passes q + filter + pagination, parses hits', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
          status: 200,
          body: {
            hits: [{ id: 'a' }, { id: 'b' }],
            estimatedTotalHits: 2,
            offset: 0,
            limit: 100,
          },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    const r = await client.search('Musum', {
      folderId: '0123456789abcdef01234567',
      offset: 0,
      limit: 50,
    });
    expect(r.ids).toEqual(['a', 'b']);
    expect(r.estimatedTotal).toBe(2);

    expect(calls.length).toBe(1);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.q).toBe('Musum');
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(50);
    expect(body.filter).toBe(
      'deletedAt IS NULL AND (hidden IS NULL OR hidden = false) AND folderId = "0123456789abcdef01234567"',
    );
  });

  it('search() with no folderId filters deleted and hidden assets', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
          status: 200,
          body: { hits: [], estimatedTotalHits: 0 },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    await client.search('Park');
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.filter).toBe('deletedAt IS NULL AND (hidden IS NULL OR hidden = false)');
  });

  it('search() throws on transport error so the route can fall back', async () => {
    const { fetchImpl } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
          throwError: new Error('ECONNREFUSED'),
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    await expect(client.search('Albany')).rejects.toThrow(/meilisearch search failed/);
  });

  it('search() exposes safe structured Meilisearch diagnostics', async () => {
    const { fetchImpl } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
          status: 400,
          body: {
            message: 'Cannot find embedder with name `caption`.',
            code: 'invalid_search_embedder',
            type: 'invalid_request',
          },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    try {
      await client.search('Albany');
      throw new Error('expected search to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(MeilisearchSearchError);
      expect((error as MeilisearchSearchError).details).toEqual({
        status: 400,
        code: 'invalid_search_embedder',
        type: 'invalid_request',
        message: 'Cannot find embedder with name `caption`.',
      });
    }
  });

  it('search errors use a useful message when Meilisearch returns an empty body', () => {
    const error = new MeilisearchSearchError(500, '');
    expect(error.details.message).toBe('Meilisearch search request failed');
    expect(error.message).toBe('meilisearch search failed: Meilisearch search request failed');
  });

  it('search() scrubs non-hex chars from folderId before injecting', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
          status: 200,
          body: { hits: [], estimatedTotalHits: 0 },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    // Attempt injection — only hex chars [0-9a-f] survive (so digits in
    // a real ObjectId still pass through).
    await client.search('park', {
      folderId: 'abc" OR x=z --',
    });
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.filter).toBe(
      'deletedAt IS NULL AND (hidden IS NULL OR hidden = false) AND folderId = "abc"',
    );
  });

  it('search() adds a hybrid block only when semantic is on AND requested', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
          status: 200,
          body: { hits: [], estimatedTotalHits: 0 },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
      semantic: true,
      semanticRatio: 0.6,
    });
    await client.search('a boy playing ball', { semantic: true });
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.hybrid).toEqual({ embedder: 'caption', semanticRatio: 0.6 });
  });

  it('search() omits hybrid when the switch is off even if requested', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
          status: 200,
          body: { hits: [], estimatedTotalHits: 0 },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
      semantic: false,
    });
    await client.search('a boy playing ball', { semantic: true });
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.hybrid).toBeUndefined();
  });

  it('search() builds a safe people IN clause', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
          status: 200,
          body: { hits: [], estimatedTotalHits: 0 },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    await client.search('ball', {
      people: ['Greyson', 'Maya "Mae" Smith'],
    });
    const body = calls[0]!.body as Record<string, unknown>;
    // Quotes inside a name are escaped so the filter expression stays valid.
    expect(body.filter).toBe(
      'deletedAt IS NULL AND (hidden IS NULL OR hidden = false) AND people IN ["Greyson", "Maya \\"Mae\\" Smith"]',
    );
  });

  it('search() supports media filters and explicit hidden inclusion', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
          status: 200,
          body: { hits: [], estimatedTotalHits: 0 },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    await client.search('installation', {
      mediaTypes: ['video', 'audio', 'video'],
      includeHidden: true,
    });
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.filter).toBe('deletedAt IS NULL AND mediaType IN ["video", "audio"]');
  });

  it('search() returns ranking scores without dropping lexical-only hits', async () => {
    const { fetchImpl } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
          status: 200,
          body: {
            hits: [{ id: 'semantic', _rankingScore: 0.91 }, { id: 'exact-lexical' }],
            estimatedTotalHits: 2,
          },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
      semantic: true,
    });
    const result = await client.search('HVAC air conditioning installation', { semantic: true });
    expect(result.ids).toEqual(['semantic', 'exact-lexical']);
    expect(result.scores).toEqual({ semantic: 0.91 });
  });
});
