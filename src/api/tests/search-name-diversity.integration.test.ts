import { describe, expect, it } from 'bun:test';
import {
  createMeilisearchClient,
  type MeilisearchAssetDoc,
} from '../src/enrichment/meilisearch-client.ts';
import {
  meilisearchHttp,
  waitForMeilisearchTask,
  type MeilisearchTaskSummary,
} from '../src/enrichment/meilisearch-transport.ts';
import corpus from './fixtures/search-relevance/corpus.json';
import queries from './fixtures/search-relevance/queries.json';
const url = process.env.MAPLE_MEILISEARCH_INTEGRATION_URL;
const embedderUrl = process.env.MAPLE_OLLAMA_INTEGRATION_URL;
const enabled = process.env.MAPLE_SEARCH_RELEVANCE === '1' && !!url && !!embedderUrl;
const pairs = queries.filter((q) => 'observeIds' in q);

// Actual Meili/Ollama and the production ranking client. No canned embeddings.
describe('#2386 reading diversity', () => {
  for (const captions of [false, true]) {
    it.skipIf(!enabled)(
      `preserves readings, pages and scores (named captions=${captions})`,
      async () => {
        const indexName = `maple_diversity_${crypto.randomUUID()}`;
        const transport = {
          url,
          apiKey: undefined,
          fetchImpl: globalThis.fetch.bind(globalThis),
          taskPollIntervalMs: 100,
          taskTimeoutMs: 900_000,
        };
        const client = createMeilisearchClient({
          ...transport,
          indexName,
          semantic: true,
          embedderUrl,
          embedderModel: 'bge-m3',
          semanticRatio: 0.5,
        });
        const extra = pairs.flatMap((p, j) => {
          const d = corpus.find((d) => d.id === p.observeIds![0])!;
          return Array.from({ length: 24 }, (_, i) => ({
            ...d,
            id: `${d.id}-crowding-${i}`,
            filename: `IMG_${6000 + j * 100 + i}.HEIC`,
            ...(captions ? { description: `${d.people![0]} enjoying the garden` } : {}),
          }));
        });
        try {
          await client.ensureIndex();
          await client.upsertBatchOrThrow!([...corpus, ...extra] as MeilisearchAssetDoc[]);
          for (const p of pairs) {
            const options = { semantic: true, limit: 150 };
            const ranked = await client.search(p.query, options);
            for (const g of p.readingGuards!) {
              const rank = ranked.ids.indexOf(g.id) + 1;
              expect(rank).toBeGreaterThan(0);
              expect(rank).toBeLessThanOrEqual(g.k);
            }
            const raw = await meilisearchHttp<{
              hits: { id: string; _rankingScore: number }[];
              estimatedTotalHits: number;
            }>(transport, 'POST', `/indexes/${indexName}/search`, {
              q: p.query,
              filter:
                'deletedAt IS NULL AND (hidden NOT EXISTS OR hidden IS NULL OR hidden = false)',
              offset: 0,
              limit: 150,
              attributesToRetrieve: ['id'],
              showRankingScore: true,
              hybrid: { embedder: 'caption', semanticRatio: 0.5 },
            });
            expect(raw.ok).toBe(true);
            expect([...ranked.ids].sort()).toEqual(raw.body!.hits.map((h) => h.id).sort());
            expect(ranked.estimatedTotal).toBe(raw.body!.estimatedTotalHits);
            for (const h of raw.body!.hits) expect(ranked.scores![h.id]).toBe(h._rankingScore);
            const pages: string[] = [];
            for (const [offset, limit] of [
              [0, 1],
              [1, 2],
              [3, 37],
              [40, 57],
              [97, 8],
              [105, 45],
            ]) {
              const page = await client.search(p.query, {
                ...options,
                offset,
                limit,
              });
              expect(page.ids).toEqual(ranked.ids.slice(offset, offset + limit));
              pages.push(...page.ids);
            }
            expect(pages).toEqual(ranked.ids);
            expect(new Set(pages).size).toBe(pages.length);
            const scoped = await client.search(p.query, {
              ...options,
              people: [corpus.find((d) => d.id === p.observeIds![0])!.people![0]],
            });
            expect(scoped.ids).not.toContain(p.observeIds![1]);
          }
          const greyson = await client.search('Greyson', {
            semantic: true,
            limit: 3,
          });
          expect(greyson.ids[0]).toBe('person-greyson-1');
          expect(greyson.ids).toContain('person-greyson-2');
          expect((await client.search('IMG_4185.MOV', { semantic: true, limit: 1 })).ids).toEqual([
            '010045ca68ac1f7f7e8b3aa02f72ac80',
          ]);
          console.error(
            JSON.stringify({
              ticket: 2386,
              captions,
              documents: corpus.length + extra.length,
              status: await client.semanticStatus!(),
            }),
          );
        } finally {
          const d = await meilisearchHttp<MeilisearchTaskSummary>(
            transport,
            'DELETE',
            `/indexes/${indexName}`,
          );
          if (d.status !== 404)
            await waitForMeilisearchTask(transport, d, 'delete owned diversity probe');
        }
      },
      900_000,
    );
  }
});
