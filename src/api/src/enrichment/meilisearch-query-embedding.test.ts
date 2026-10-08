/**
 * #4437 — hybrid searches carry a query vector Maple computed through the
 * configured Ollama endpoint, and a slow or failing embed degrades to a
 * keyword-only search instead of waiting out Meilisearch's own timeout.
 *
 * Both Ollama and Meilisearch are real HTTP servers here, so the deadline and
 * the request bodies are exercised through the actual transport.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { ASSETS_INDEX, createMeilisearchClient } from './meilisearch-client.ts';
import { createQueryEmbedder } from './meilisearch-query-embedding.ts';

const MODEL = 'bge-m3:latest';
const VECTOR = [0.25, -0.5, 0.75];
const TEST_DEADLINE_MS = 60;

interface FakeOllama {
  url: string;
  embeds: Array<Record<string, unknown>>;
}

interface FakeMeili {
  url: string;
  searches: Array<Record<string, unknown>>;
  embedderReads: number[];
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function fakeOllama(answer: () => Response | Promise<Response>): FakeOllama {
  const embeds: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== '/api/embed') return new Response(null, { status: 404 });
      embeds.push((await req.json()) as Record<string, unknown>);
      return answer();
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, embeds };
}

function fakeMeili(liveEmbedder: Record<string, unknown> | null): FakeMeili {
  const searches: Array<Record<string, unknown>> = [];
  const embedderReads: number[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === 'GET' && path === `/indexes/${ASSETS_INDEX}/settings/embedders`) {
        embedderReads.push(Date.now());
        return Response.json(liveEmbedder === null ? {} : { caption: liveEmbedder });
      }
      if (req.method === 'POST' && path === `/indexes/${ASSETS_INDEX}/search`) {
        searches.push((await req.json()) as Record<string, unknown>);
        return Response.json({ hits: [{ id: 'snowy-field' }], estimatedTotalHits: 1 });
      }
      return new Response(null, { status: 404 });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, searches, embedderReads };
}

function matchingEmbedder(ollama: FakeOllama): Record<string, unknown> {
  return { source: 'ollama', model: MODEL, url: `${ollama.url}/api/embed` };
}

function client(meili: FakeMeili, ollama: FakeOllama, semantic = true) {
  return createMeilisearchClient({
    url: meili.url,
    semantic,
    semanticRatio: 0.5,
    embedderUrl: ollama.url,
    embedderModel: MODEL,
    queryEmbedDeadlineMs: TEST_DEADLINE_MS,
  });
}

const embedded = () => Response.json({ embeddings: [VECTOR] });

describe('hybrid search query embeddings (#4437)', () => {
  it('sends the Ollama vector with q and the hybrid block, keeping the model loaded', async () => {
    const ollama = fakeOllama(embedded);
    const meili = fakeMeili(matchingEmbedder(ollama));

    const result = await client(meili, ollama).search('  winter   scenes ', { semantic: true });

    expect(result.ids).toEqual(['snowy-field']);
    expect(ollama.embeds).toEqual([{ model: MODEL, input: 'winter scenes', keep_alive: '24h' }]);
    expect(meili.searches[0]).toMatchObject({
      q: '  winter   scenes ',
      vector: VECTOR,
      hybrid: { embedder: 'caption', semanticRatio: 0.5 },
    });
  });

  it('reuses a cached vector without calling Ollama again', async () => {
    const ollama = fakeOllama(embedded);
    const meili = fakeMeili(matchingEmbedder(ollama));
    const search = client(meili, ollama);

    await search.search('winter', { semantic: true });
    await search.search('winter ', { semantic: true });

    expect(ollama.embeds).toHaveLength(1);
    expect(meili.searches.map((body) => body.vector)).toEqual([VECTOR, VECTOR]);
  });

  it('searches keyword-only within the deadline when the model is cold, and warms it', async () => {
    const ollama = fakeOllama(async () => {
      await Bun.sleep(TEST_DEADLINE_MS * 5);
      return embedded();
    });
    const meili = fakeMeili(matchingEmbedder(ollama));
    const search = client(meili, ollama);

    const started = performance.now();
    await search.search('snow', { semantic: true });
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(TEST_DEADLINE_MS * 4);
    expect(meili.searches[0]!.hybrid).toBeUndefined();
    expect(meili.searches[0]!.vector).toBeUndefined();
    expect(ollama.embeds).toHaveLength(1);

    // The slow embed was not abandoned: it finishes in the background, so the
    // next search for the same text is warm and hybrid without a new call.
    await Bun.sleep(TEST_DEADLINE_MS * 6);
    await search.search('snow', { semantic: true });
    expect(ollama.embeds).toHaveLength(1);
    expect(meili.searches[1]).toMatchObject({ vector: VECTOR, hybrid: { embedder: 'caption' } });
  });

  it('searches keyword-only when Ollama fails', async () => {
    const ollama = fakeOllama(() => new Response('model not found', { status: 404 }));
    const meili = fakeMeili(matchingEmbedder(ollama));

    await client(meili, ollama).search('winter', { semantic: true });

    expect(ollama.embeds).toHaveLength(1);
    expect(meili.searches[0]!.hybrid).toBeUndefined();
    expect(meili.searches[0]!.vector).toBeUndefined();
  });

  it('never calls Ollama when semantic search is disabled', async () => {
    const ollama = fakeOllama(embedded);
    const meili = fakeMeili(matchingEmbedder(ollama));

    await client(meili, ollama, false).search('winter', { semantic: true });
    await client(meili, ollama).search('winter', { semantic: false });

    expect(ollama.embeds).toHaveLength(0);
    expect(meili.searches.map((body) => body.hybrid)).toEqual([undefined, undefined]);
  });

  it('leaves the embedding to Meilisearch when the live embedder is a different model', async () => {
    const ollama = fakeOllama(embedded);
    const meili = fakeMeili({ ...matchingEmbedder(ollama), model: 'nomic-embed-text' });

    await client(meili, ollama).search('winter', { semantic: true });

    expect(ollama.embeds).toHaveLength(0);
    expect(meili.searches[0]!.vector).toBeUndefined();
    expect(meili.searches[0]!.hybrid).toEqual({ embedder: 'caption', semanticRatio: 0.5 });
  });

  it('leaves the embedding to Meilisearch when the live embedder points elsewhere', async () => {
    const ollama = fakeOllama(embedded);
    const meili = fakeMeili({
      ...matchingEmbedder(ollama),
      url: 'http://old-host:11434/api/embed',
    });

    await client(meili, ollama).search('winter', { semantic: true });

    expect(ollama.embeds).toHaveLength(0);
    expect(meili.searches[0]!.vector).toBeUndefined();
  });

  it('trusts an in-sync settings check without reading the live embedder', async () => {
    const ollama = fakeOllama(embedded);
    const meili = fakeMeili(null);
    const config = {
      url: meili.url,
      apiKey: undefined,
      fetchImpl: globalThis.fetch.bind(globalThis),
      taskPollIntervalMs: 10,
      taskTimeoutMs: 1_000,
      indexName: ASSETS_INDEX,
      embedderUrl: ollama.url,
      embedderModel: MODEL,
    };

    const inSync = await createQueryEmbedder(config, 'caption', () => true).hybridQuery('winter');
    const unsynced = await createQueryEmbedder(config, 'caption', () => null).hybridQuery('winter');
    const drifted = await createQueryEmbedder(config, 'caption', () => false).hybridQuery('winter');

    expect(inSync).toEqual({ kind: 'vector', vector: VECTOR });
    expect(unsynced).toEqual({ kind: 'meili-embeds' });
    expect(drifted).toEqual({ kind: 'meili-embeds' });
    expect(meili.embedderReads).toHaveLength(2);
  });
});
