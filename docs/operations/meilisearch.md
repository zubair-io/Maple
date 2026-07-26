# Operating hybrid asset search

Maple uses Meilisearch for lexical ranking and hybrid semantic search, with an
Ollama embedding model managed by Meilisearch. MongoDB remains canonical.
Meilisearch contains a rebuildable projection and can be lost or taken offline
without losing asset metadata.

When semantic embedding fails, Maple retries a lexical Meilisearch query. When
Meilisearch itself is unavailable, Maple falls back to Mongo text search and
exact filename matching. Every service-search response reports `modeUsed` and
`fallbackReason`, so consumers can tell which path served it.

## Requirements

- A current stable Meilisearch v1 release with hybrid search and embedders.
- An Ollama service reachable **from the Meilisearch host**.
- The `nomic-embed-text` model (or the model selected below) pulled in Ollama.
- TLS between service consumers and Maple. Plain HTTP is accepted only on
  loopback for local development.

Pull the default model:

```sh
ollama pull nomic-embed-text
```

Run Meilisearch with a persistent data volume and production master key. For
example:

```sh
docker run -d \
  --name maple-meilisearch \
  -p 7700:7700 \
  -e MEILI_MASTER_KEY='<long-random-secret>' \
  -e MEILI_ENV=production \
  -v maple-meili-data:/meili_data \
  getmeili/meilisearch:latest
```

Keep both the Meilisearch key and Maple service keys in a secrets manager.

## Maple configuration

Set these values in `src/api/.env`:

```sh
MAPLE_MEILISEARCH_URL=http://meili.lan:7700
MAPLE_MEILISEARCH_API_KEY=<meilisearch-key>
MAPLE_MEILISEARCH_SEMANTIC=true
MAPLE_MEILISEARCH_EMBEDDER_URL=http://ollama.lan:11434
MAPLE_MEILISEARCH_EMBEDDER_MODEL=nomic-embed-text
MAPLE_MEILISEARCH_SEMANTIC_RATIO=0.5
```

`MAPLE_MEILISEARCH_SEMANTIC_RATIO` is clamped to `0..1`: `0` is lexical-only,
`1` is semantic-only, and the default `0.5` balances both. The bundled Docker
deployment turns the semantic switch on by default when a Meilisearch URL is
provided. Direct Bun deployments must set it explicitly.

The URL and Meilisearch API key may also be set under
**Settings → Workers → meili**. Saved values override the environment. The
service-search request limit is configured there as a DB-backed runtime setting.
The embedder URL, model, semantic switch, and blend remain deployment settings.

At API startup Maple creates the `assets` index, applies settings, and
registers the `caption` Ollama embedder. This happens in the HTTP tier even
when the background worker process is disabled.

The searchable projection includes:

- filename, unified search text, description, named people, and OCR text;
- transcript, vision subjects/setting/activity/objects in unified search text;
- library, capture time, deletion state, hidden state, and media type;
- vectors generated from unified text, description, and named people.

Filename is the highest-priority searchable attribute so identifiers such as
`IMG_4185.MOV` remain strong lexical matches while conceptual searches such as
`HVAC air conditioning installation` can match descriptive or transcript text.

## Verify configuration and coverage

Use an owner/user access token:

```sh
curl -H 'Authorization: Bearer <maple-user-jwt>' \
  https://maple.example/api/admin/enrichment/meilisearch-status
```

The response reports:

- whether semantic search is enabled;
- Meilisearch and embedder reachability;
- configured embedder/model/blend;
- raw live-Mongo, indexed, vectorized, and tombstoned document counts;
- indexing activity and resumable backfill progress.

`embedderConfigured`, `embedderReachable`, and `semantic.enabled` should all be
`true`. Indexed/vectorized counts are index-wide populations and can include
tombstones, so do not treat their ratio to the live-Mongo count as a coverage
percentage. During a backfill, hybrid search continues to return lexical-only
documents while embeddings catch up.

## Resumable backfill

In **Settings → Workers → Migration**, enable **Backfill semantic-search
index**. The migration worker sends bounded bulk tasks, stores a durable Mongo
cursor, and reports processed, remaining, and error counts in that panel. It
automatically disables itself when complete. Pause it with the toggle; use
**Reset** to clear its cursor and intentionally restart from the beginning.
For a slow or CPU-bound Ollama host, increase **Index task timeout** on the
Meilisearch worker before starting the migration.

The authenticated admin endpoint remains available for automation and
troubleshooting. Repeat the request until `complete` is `true`; subsequent
polls remain complete and do not restart the sweep unless `reset=true` is
explicitly supplied:

```sh
curl -X POST \
  -H 'Authorization: Bearer <maple-user-jwt>' \
  'https://maple.example/api/admin/enrichment/backfill-meilisearch?batchSize=250'
```

The response contains per-call and cumulative `scanned`, `upserted`, `skipped`,
and `errors` counters plus `nextCursor`. A failed bulk write retains the cursor,
so the next request retries the same batch. Use `reset=true` to intentionally
restart from the beginning:

```sh
curl -X POST \
  -H 'Authorization: Bearer <maple-user-jwt>' \
  'https://maple.example/api/admin/enrichment/backfill-meilisearch?batchSize=250&reset=true'
```

Upserts are idempotent on `maple_id`. Once the initial backfill is complete,
changes to description, transcript, OCR, people assignments/names, place,
vision metadata, and sidecar-derived hidden metadata re-arm the Meilisearch
stage automatically.

## Maple-owned service API

External consumers such as SugarMaple do not receive a Meilisearch key and do
not query the sidecar directly. Create a dedicated, least-privilege Maple key
using an owner JWT:

```sh
curl -X POST \
  -H 'Authorization: Bearer <maple-owner-jwt>' \
  -H 'X-Step-Up: <fresh-step-up-token>' \
  -H 'Content-Type: application/json' \
  -d '{"name":"SugarMaple","scopes":["assets:search"]}' \
  https://maple.example/api/admin/service-api-keys
```

The plaintext `maple_sk_…` key appears only in this creation response. Maple
stores only its SHA-256 secret hash. List metadata or revoke a key with:

```sh
curl -H 'Authorization: Bearer <maple-owner-jwt>' \
  https://maple.example/api/admin/service-api-keys

curl -X DELETE \
  -H 'Authorization: Bearer <maple-owner-jwt>' \
  -H 'X-Step-Up: <fresh-step-up-token>' \
  https://maple.example/api/admin/service-api-keys/<key-id>
```

Search via the Maple-owned contract:

```sh
curl -X POST \
  -H 'Authorization: Bearer <maple-service-key>' \
  -H 'Content-Type: application/json' \
  -d '{
    "query":"HVAC air conditioning installation",
    "mode":"hybrid",
    "limit":10,
    "filters":{"mediaTypes":["video"]}
  }' \
  https://maple.example/api/search/assets
```

The response contains ordered `assetId`/`score` entries, `modeRequested`,
`modeUsed`, `fallbackReason`, and `total`. Hidden and deleted assets are
excluded by default. Keys are individually revocable and expirable, scoped to
`assets:search`, rate-limited, and logged by key ID/prefix without logging the
secret or query.

## Outages, rollback, and sizing

To roll back semantic search without interrupting lexical search, set
`MAPLE_MEILISEARCH_SEMANTIC=false` and restart Maple. To bypass Meilisearch
entirely, remove its URL; exact filename and Mongo lexical search remain.

Embedding capacity has three components:

- Ollama memory for the selected model and inference working set;
- roughly `document_count × embedding_dimensions × 4` bytes of raw float
  vectors, plus Meilisearch graph/index overhead;
- temporary disk and CPU while Meilisearch processes backfill tasks.

Start with a bounded backfill, watch the status endpoint and service memory,
then increase `batchSize` only if indexing stays healthy. Keep the Meilisearch
data volume backed up only for faster recovery; Mongo and XMP are the sources
of truth, so a wiped search index can always be rebuilt.
