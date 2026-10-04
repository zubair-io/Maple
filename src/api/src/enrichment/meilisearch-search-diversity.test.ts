import { describe, expect, it } from 'bun:test';
import {
  searchWithReadingDiversity,
  type MeiliSearchResponse,
} from './meilisearch-search-diversity.ts';
import { MeilisearchSearchError } from './meilisearch-search-error.ts';
import type { MeilisearchTransportConfig } from './meilisearch-transport.ts';

type Hit = MeiliSearchResponse['hits'][number];
const request = Object.freeze({ q: 'Rose', offset: 0, limit: 100, filter: 'hidden = false' });
const hit = (id: string, fields: string[] = [], score = 0.75): Hit => ({
  id,
  _rankingScore: score,
  _matchesPosition: Object.fromEntries(fields.map((field) => [field, [{ start: 0, length: 4 }]])),
});

function transport(respond: (body: Record<string, unknown>) => Response) {
  const calls: Record<string, unknown>[] = [];
  const config: MeilisearchTransportConfig = {
    url: 'http://search-unit.invalid',
    apiKey: undefined,
    taskPollIntervalMs: 0,
    taskTimeoutMs: 0,
    fetchImpl: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe('http://search-unit.invalid/indexes/owned/search');
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push(body);
        return respond(body);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  };
  return { config, calls };
}

function native(hits: Hit[], total = hits.length) {
  return transport((body) =>
    Response.json({
      hits: hits.slice(body.offset as number, (body.offset as number) + (body.limit as number)),
      estimatedTotalHits: total,
    }),
  );
}

describe('search reading diversity without external services (#2386)', () => {
  it('permutes independent readings while preserving scores, positions, total and membership', async () => {
    const hits = [
      hit('P1', ['people'], 0.98),
      hit('P2', ['people'], 0.96),
      hit('caption-with-name', ['people', 'description'], 0.94),
      hit('semantic-only', [], 0.93),
      hit('C1', ['description'], 0.91),
      hit('C2', ['ocrText'], 0.89),
    ];
    const snapshot = structuredClone(hits);
    const { config, calls } = native(hits, 413);
    const actual = await searchWithReadingDiversity(config, 'owned', request);
    const expected = [hits[0]!, hits[4]!, hits[1]!, hits[5]!, hits[2]!, hits[3]!];
    expect(actual).toEqual({ hits: expected, estimatedTotalHits: 413 });
    expect(new Set(actual.hits.map((h) => h.id))).toEqual(new Set(hits.map((h) => h.id)));
    expect(hits).toEqual(snapshot);
    expect(request).toEqual({ q: 'Rose', offset: 0, limit: 100, filter: 'hidden = false' });
    expect(calls).toEqual([{ ...request, showMatchesPosition: true }]);
  });

  for (const [name, hits] of [
    ['no independent content', [hit('P1', ['people']), hit('P2', ['people', 'description'])]],
    [
      'explicit filename leader',
      [hit('P1', ['people', 'filename']), hit('P2', ['people']), hit('C', ['description'])],
    ],
    ['uncrowded head', [hit('C', ['description']), hit('P1', ['people']), hit('P2', ['people'])]],
    ['empty head', []],
  ] as const) {
    it(`preserves native order for ${name}`, async () => {
      const { config, calls } = native([...hits]);
      expect(await searchWithReadingDiversity(config, 'owned', request)).toEqual({
        hits: [...hits],
        estimatedTotalHits: hits.length,
      });
      expect(calls).toHaveLength(1);
    });
  }

  it('slices one stable permutation across the head/tail boundary without loss or duplication', async () => {
    const hits = Array.from({ length: 150 }, (_, i) =>
      hit(String(i), i < 2 ? ['people'] : i === 25 || i === 50 ? ['description'] : [], i / 200),
    );
    const { config, calls } = native(hits, 777);
    const expected = [
      hits[0]!,
      hits[25]!,
      hits[1]!,
      hits[50]!,
      ...hits.filter((h) => !['0', '1', '25', '50'].includes(h.id)),
    ];
    const pages = [];
    for (const [offset, limit] of [
      [0, 3],
      [3, 94],
      [97, 8],
      [105, 45],
    ]) {
      const result = await searchWithReadingDiversity(config, 'owned', {
        ...request,
        offset,
        limit,
      });
      expect(result).toEqual({
        hits: expected.slice(offset, offset + limit),
        estimatedTotalHits: 777,
      });
      pages.push(...result.hits);
    }
    expect(pages).toEqual(expected);
    expect(new Set(pages.map((h) => h.id)).size).toBe(150);
    expect(calls).toEqual([
      { ...request, showMatchesPosition: true },
      { ...request, showMatchesPosition: true },
      { ...request, showMatchesPosition: true },
      { ...request, offset: 100, limit: 5 },
      { ...request, offset: 105, limit: 45 },
    ]);
  });

  it('uses one fetch for an exhausted short head even when the requested window crosses 100', async () => {
    const hits = [hit('P1', ['people']), hit('P2', ['people']), hit('C1', ['description'])];
    const { config, calls } = native(hits);
    expect(
      await searchWithReadingDiversity(config, 'owned', { ...request, offset: 1, limit: 150 }),
    ).toEqual({
      hits: [hits[2]!, hits[1]!],
      estimatedTotalHits: 3,
    });
    expect(calls).toEqual([{ ...request, showMatchesPosition: true }]);
  });

  for (const body of [
    { ...request, limit: 0 },
    { ...request, offset: 100 },
    { ...request, offset: 105, limit: 45 },
    { ...request, q: '' },
    { ...request, q: '   ' },
    { ...request, q: '  Rose beach  ' },
    { ...request, q: 'Rose-beach' },
    { offset: 0, limit: 100, filter: 'hidden = false' },
  ]) {
    it(`uses an untouched native request for ${JSON.stringify(body)}`, async () => {
      const hits = Array.from({ length: 150 }, (_, i) => hit(String(i), ['description'], i / 200));
      const { config, calls } = native(hits, 257);
      expect(await searchWithReadingDiversity(config, 'owned', body)).toEqual({
        hits: hits.slice(body.offset, body.offset + body.limit),
        estimatedTotalHits: 257,
      });
      expect(calls).toEqual([body]);
    });
  }

  it('throws a recoverable structured error and allows a subsequent healthy request', async () => {
    const { config, calls } = transport(() =>
      calls.length === 1
        ? Response.json(
            { code: 'index_not_found', type: 'invalid_request', message: 'Index absent' },
            { status: 404 },
          )
        : Response.json({ hits: [hit('healthy')], estimatedTotalHits: 1 }),
    );
    const failed = searchWithReadingDiversity(config, 'owned', request);
    await expect(failed).rejects.toBeInstanceOf(MeilisearchSearchError);
    await expect(failed).rejects.toMatchObject({
      details: {
        status: 404,
        code: 'index_not_found',
        type: 'invalid_request',
        message: 'Index absent',
      },
    });
    expect(await searchWithReadingDiversity(config, 'owned', request)).toEqual({
      hits: [hit('healthy')],
      estimatedTotalHits: 1,
    });
    expect(calls).toHaveLength(2);
  });

  it('propagates a failed native tail instead of returning a misleading partial page', async () => {
    const hits = Array.from({ length: 100 }, (_, i) => hit(String(i)));
    const { config, calls } = transport((body) =>
      body.offset === 0
        ? Response.json({ hits, estimatedTotalHits: 150 })
        : new Response('upstream unavailable', { status: 503 }),
    );
    await expect(
      searchWithReadingDiversity(config, 'owned', { ...request, offset: 97, limit: 8 }),
    ).rejects.toMatchObject({ details: { status: 503, message: 'upstream unavailable' } });
    expect(calls).toHaveLength(2);
  });
});
