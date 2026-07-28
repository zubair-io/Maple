/**
 * Hybrid search relevance gate (#2384).
 *
 * Measures ranking quality against a committed corpus using a REAL
 * Meilisearch and a REAL Ollama embedder. There is no offline way to measure
 * embedding relevance, so this skip-passes when either is unconfigured —
 * same convention as `test_color_pipeline.sh`.
 *
 * Run it through `src/scripts/test_search_relevance.sh`, which sets the env
 * and handles the skip.
 *
 * The corpus lives in `fixtures/search-relevance/`. `queries.json` carries
 * two kinds of entry:
 *   - `mustBeInTop` — a hard per-query rank assertion (the #2384 case, exact
 *     filename behaviour, the named-person guard).
 *   - `observeIds`  — recorded in the report but NOT asserted; used for cases
 *     another ticket owns (see the `Rose` entry and #2386).
 */

import { describe, expect, it } from 'bun:test';
import {
  createMeilisearchClient,
  type MeilisearchAssetDoc,
} from '../src/enrichment/meilisearch-client.ts';
import { meanReciprocalRank, recallAtK } from '../src/enrichment/search-relevance-metrics.ts';
import budgets from './fixtures/search-relevance/budgets.json';
import corpus from './fixtures/search-relevance/corpus.json';
import queries from './fixtures/search-relevance/queries.json';

const enabled = process.env.MAPLE_SEARCH_RELEVANCE === '1';
const meiliUrl = process.env.MAPLE_MEILISEARCH_INTEGRATION_URL;
const ollamaUrl = process.env.MAPLE_OLLAMA_INTEGRATION_URL;
const ratio = Number(process.env.MAPLE_SEMANTIC_RATIO ?? budgets.semanticRatio);

interface QueryCase {
  query: string;
  relevantIds: string[];
  mustBeInTop?: { id: string; k: number };
  observeIds?: string[];
  note?: string;
}

const cases = queries as QueryCase[];

describe('hybrid search relevance gate (#2384)', () => {
  it.skipIf(!enabled || !meiliUrl || !ollamaUrl)(
    'meets the committed Recall@10 / MRR floors and every per-query rank guard',
    async () => {
      const client = createMeilisearchClient({
        url: meiliUrl,
        semantic: true,
        embedderUrl: ollamaUrl!,
        embedderModel: 'bge-m3',
        semanticRatio: ratio,
        taskPollIntervalMs: 200,
        taskTimeoutMs: 15 * 60_000,
      });
      await client.ensureIndex();
      await client.upsertBatchOrThrow!(corpus as MeilisearchAssetDoc[]);

      // One search per case, reused for both the metrics and the guards —
      // re-querying would double the wall clock and could disagree with
      // itself if the index were still settling.
      const ranked = new Map<string, string[]>();
      for (const testCase of cases) {
        const result = await client.search(testCase.query, { semantic: true, limit: 50 });
        ranked.set(testCase.query, result.ids);
      }

      const evaluated = cases.map((testCase) => ({
        ranked: ranked.get(testCase.query)!,
        relevant: testCase.relevantIds,
      }));
      const report = cases.map((testCase) => {
        const ids = ranked.get(testCase.query)!;
        const rankOf = (id: string): number | null => {
          const index = ids.indexOf(id);
          return index === -1 ? null : index + 1;
        };
        return {
          query: testCase.query,
          recallAt10: recallAtK(ids, testCase.relevantIds, 10),
          ranks: Object.fromEntries(testCase.relevantIds.map((id) => [id, rankOf(id)])),
          ...(testCase.observeIds
            ? {
                // Unasserted ranks for cases another ticket owns (#2386).
                observed: Object.fromEntries(testCase.observeIds.map((id) => [id, rankOf(id)])),
              }
            : {}),
        };
      });

      const recall =
        evaluated.reduce((sum, e) => sum + recallAtK(e.ranked, e.relevant, 10), 0) /
        evaluated.length;
      const mrr = meanReciprocalRank(evaluated);
      console.error(
        JSON.stringify({ semanticRatio: ratio, recallAt10: recall, mrr, report }, null, 2),
      );

      for (const testCase of cases) {
        if (!testCase.mustBeInTop) continue;
        const rank = ranked.get(testCase.query)!.indexOf(testCase.mustBeInTop.id) + 1;
        expect(
          rank,
          `"${testCase.query}" → ${testCase.mustBeInTop.id} must be in the top ${testCase.mustBeInTop.k}`,
        ).toBeGreaterThan(0);
        expect(
          rank,
          `"${testCase.query}" → ${testCase.mustBeInTop.id} ranked ${rank}, want ≤ ${testCase.mustBeInTop.k}`,
        ).toBeLessThanOrEqual(testCase.mustBeInTop.k);
      }

      expect(recall).toBeGreaterThanOrEqual(budgets.minRecallAt10);
      expect(mrr).toBeGreaterThanOrEqual(budgets.minMrr);
    },
    20 * 60_000,
  );
});
