/**
 * Export a sample of live Meilisearch asset documents as a relevance-corpus
 * fixture (#2384).
 *
 * The committed corpus is hand-authored, which risks exactly the overfitting
 * the issue warns about. This pulls REAL documents — real transcripts, real
 * captions, real OCR — so the gate can be grown against the distribution the
 * ranking actually faces rather than against invented text.
 *
 * Usage:
 *   MAPLE_MEILISEARCH_URL=http://localhost:7700 \
 *     bun run tools/export-search-corpus.ts "HVAC air conditioning installation" 60 \
 *     > /tmp/sample.json
 *
 * Pass an empty query to sample the index broadly:
 *   bun run tools/export-search-corpus.ts "" 200 > /tmp/sample.json
 *
 * REVIEW THE OUTPUT BEFORE COMMITTING IT. It contains real filenames,
 * captions, transcripts, place names, and person names from the operator's
 * library. Redact anything that should not live in the repo, then merge the
 * documents into tests/fixtures/search-relevance/corpus.json and add labels
 * to queries.json.
 */

const url = process.env.MAPLE_MEILISEARCH_URL;
const apiKey = process.env.MAPLE_MEILISEARCH_API_KEY;
const query = Bun.argv[2] ?? '';
const limit = Number(Bun.argv[3] ?? 60);

if (!url) {
  console.error('MAPLE_MEILISEARCH_URL is required');
  process.exit(1);
}
if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
  console.error(`limit must be an integer in [1, 1000] — got ${Bun.argv[3]}`);
  process.exit(1);
}

const response = await fetch(`${url.replace(/\/$/, '')}/indexes/assets/search`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  },
  body: JSON.stringify({
    q: query,
    limit,
    filter: 'deletedAt IS NULL AND (hidden IS NULL OR hidden = false)',
  }),
});

if (!response.ok) {
  console.error(`meilisearch search failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}

const body = (await response.json()) as { hits: Array<Record<string, unknown>> };
// Drop Meilisearch's per-hit annotations; they are not document fields and
// would fail the corpus-integrity test.
const stripped = body.hits.map(({ _rankingScore, _formatted, ...doc }) => doc);
console.error(`exported ${stripped.length} document(s) for query ${JSON.stringify(query)}`);
console.log(JSON.stringify(stripped, null, 2));
