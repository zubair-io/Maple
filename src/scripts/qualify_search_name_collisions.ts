import {
  createMeilisearchClient,
  type MeilisearchAssetDoc,
} from '../api/src/enrichment/meilisearch-client.ts';
import {
  meilisearchHttp,
  waitForMeilisearchTask,
  type MeilisearchTaskSummary,
} from '../api/src/enrichment/meilisearch-transport.ts';
import corpus from '../api/tests/fixtures/search-relevance/corpus.json';
import queries from '../api/tests/fixtures/search-relevance/queries.json';
import budgets from '../api/tests/fixtures/search-relevance/budgets.json';

const url = process.env.MAPLE_MEILISEARCH_INTEGRATION_URL;
const embedderUrl = process.env.MAPLE_OLLAMA_INTEGRATION_URL;
if (!url || !embedderUrl) {
  console.error('Integration URLs unset — skipping name-collision qualification');
  process.exit(0);
}

const transport = {
  url,
  apiKey: undefined,
  fetchImpl: globalThis.fetch.bind(globalThis),
  taskPollIntervalMs: 200,
  taskTimeoutMs: 15 * 60_000,
};
const indexName = `maple_collision_probe_${crypto.randomUUID()}`;
const client = createMeilisearchClient({
  ...transport,
  indexName,
  semantic: true,
  embedderUrl,
  embedderModel: 'bge-m3',
  semanticRatio: budgets.semanticRatio,
});
const pairs = queries.filter((query) => 'observeIds' in query);
const copiesPerName = 25;
const extra = pairs.flatMap((pair, pairIndex) => {
  const source = corpus.find((doc) => doc.id === pair.observeIds![0])!;
  return Array.from({ length: copiesPerName - 1 }, (_, index) => ({
    ...source,
    id: `${source.id}-crowding-${index}`,
    filename: `IMG_${6000 + pairIndex * 100 + index}.HEIC`,
  }));
});

try {
  await client.ensureIndex();
  await client.upsertBatchOrThrow!([...corpus, ...extra] as MeilisearchAssetDoc[]);
  const observations = [];
  for (const pair of pairs) {
    const result = await client.search(pair.query, { semantic: true, limit: 150 });
    observations.push({
      query: pair.query,
      observed: Object.fromEntries(
        pair.observeIds!.map((id) => [id, result.ids.indexOf(id) + 1 || null]),
      ),
      top10: result.ids.slice(0, 10),
    });
  }
  const greyson = await client.search('Greyson', { semantic: true, limit: 50 });
  console.log(
    JSON.stringify(
      {
        ticket: '#2386',
        protocol: 'Synthetic crowding diagnostic; reports ranks, not an acceptance gate',
        semanticRatio: budgets.semanticRatio,
        documents: corpus.length + extra.length,
        copiesPerName,
        observations,
        greysonTop3: greyson.ids.slice(0, 3),
        status: await client.semanticStatus!(),
      },
      null,
      2,
    ),
  );
} finally {
  const deletion = await meilisearchHttp<MeilisearchTaskSummary>(
    transport,
    'DELETE',
    `/indexes/${indexName}`,
  );
  if (deletion.status !== 404) {
    await waitForMeilisearchTask(transport, deletion, 'delete owned collision probe');
  }
}
