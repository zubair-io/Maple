# Operating Meilisearch alongside Maple

Maple's typo-tolerant photo search (Phase 7 of the indexer-enrichment
roadmap) is powered by an optional Meilisearch sidecar. The sidecar
deployment shape mirrors Nominatim: the operator runs Meilisearch
elsewhere — a Proxmox VM, a Docker container on a NAS, or a separate
host — and Maple is purely a client.

When the sidecar is unconfigured or unreachable, the API falls back to
the Mongo `$text` index from Phase 3. Search keeps working; users just
lose typo tolerance (`Musum` → `Museum`, `Pak` → `Park`).

## Minimum version

Use the latest stable v1.x release of Meilisearch. Maple is tested
against v1.x and uses only documented v1 endpoints (`/health`,
`/indexes`, `/indexes/<uid>/settings`, `/indexes/<uid>/documents`,
`/indexes/<uid>/search`).

## Running the service

Two common shapes:

### Single binary

```sh
# https://www.meilisearch.com/docs/learn/getting_started/installation
curl -L https://install.meilisearch.com | sh

./meilisearch \
  --http-addr 0.0.0.0:7700 \
  --master-key "$(openssl rand -hex 32)" \
  --db-path ./data.ms \
  --env production
```

### Docker

```sh
docker run -d \
  --name maple-meilisearch \
  -p 7700:7700 \
  -e MEILI_MASTER_KEY="$(openssl rand -hex 32)" \
  -e MEILI_ENV=production \
  -v maple-meili-data:/meili_data \
  getmeili/meilisearch:latest
```

The master key is sensitive — keep it in your secrets manager. Maple
sends it as a bearer token on every request.

## Pointing Maple at the sidecar

The URL and the API key can each be set from the Settings UI or via env vars.

### From the Settings UI (no restart)

Owners can set both at **Settings → Workers → meili** (Meilisearch URL + API
key). The "Test connection" button health-checks the URL with the key you've
typed (or the saved/env key) before you save. On save, Maple rebuilds the
client and re-creates the index in the background — the running process
(search route and the `meili` stage) picks up the change with no restart.

Saved values are persisted in the `app_settings` Mongo doc and **take
precedence over the env vars**. Clear the URL to fall back to the env var (or
disable the sidecar when neither is set).

The **API key is write-only** in the UI: it is never echoed back (the config
endpoint reports only whether a key is set), and it is stored in the database
in plaintext — so treat database access as equivalent to key access. Leaving
the key field blank on save keeps the existing key; with no saved key the
client falls back to `MAPLE_MEILISEARCH_API_KEY`.

### From the environment

Set env vars in Maple's `.env` (see `src/api/.env.example`):

```sh
MAPLE_MEILISEARCH_URL=http://meili.lan:7700
MAPLE_MEILISEARCH_API_KEY=your-master-key-or-search-key
```

Restart the API. The boot log shows one of:

```
Meilisearch sidecar ready
```

```
Meilisearch URL unset (DB + MAPLE_MEILISEARCH_URL) — sidecar disabled
```

```
Meilisearch health check failed; search will fall back to Mongo $text
```

The third case is non-fatal — fix the URL (via the UI or env) or start the
service; the next search request uses Meilisearch again with no restart.

## Index settings Maple expects

Maple's boot path calls `ensureIndex()` to create the `assets` index
(primary key `id`) and apply these settings on every start:

| Setting                | Value                       |
| ---------------------- | --------------------------- |
| `searchableAttributes` | `["searchBlob"]`            |
| `filterableAttributes` | `["folderId", "deletedAt"]` |
| `sortableAttributes`   | `["capturedAt"]`            |

Typo tolerance is on by default in Meilisearch; we do not override it.
The fields above mirror the document shape the geocode worker pushes:

```json
{
  "id": "<asset.maple_id>",
  "searchBlob": "<denormalised location text>",
  "folderId": "<library hex objectid>",
  "capturedAt": "2024-06-01T12:00:00.000Z",
  "deletedAt": null
}
```

`searchBlob` is identical to the `place.search_blob` field the Mongo
text index already feeds on, so the two backends agree on what is
searchable.

## Seeding the index

After standing up a fresh Meilisearch instance (or recovering from a
data loss), backfill the index from Mongo:

```sh
curl -X POST \
  -H "Authorization: Bearer <maple-jwt>" \
  http://maple.lan:3000/api/admin/enrichment/backfill-meilisearch
```

The route iterates every asset with a non-empty `place.search_blob` in
batches of 1000 and upserts them to Meilisearch. It is idempotent — run
it twice and you get the same index.

The response includes `{ scanned, upserted, skipped, errors }` so you
can confirm the population matches your Mongo asset count.

## Verifying the round trip

After the backfill, hit the search route with a typo to confirm
Meilisearch is in the path:

```sh
curl -H "Authorization: Bearer <maple-jwt>" \
  'http://maple.lan:3000/api/search?placeQuery=Musum'
```

Without Meilisearch this returns 0 (the Mongo `$text` index does not
support typo tolerance). With Meilisearch you should see your museum
photos.

## Recovering from outages

Stopping Meilisearch is non-destructive. Maple logs a warning per
fallback search (look for `meilisearch query failed; falling back to
mongo $text` in `enrichment:meilisearch` and `search` components) and
keeps serving requests via the Mongo path.

When you bring Meilisearch back, the next request that lands on the
search route uses it again — there is no need to restart Maple.

If Meilisearch loses data (e.g. the `data.ms` volume was wiped), call
the backfill route again to repopulate the index.

## Privacy and PII

Meilisearch contains the same `searchBlob` text the Mongo `$text`
index does — public location names, addresses, country codes. It does
NOT contain filenames, descriptions, EXIF, or face data. If a future
phase widens the blob (for example to include LLM captions), review the
privacy and exfiltration model before enabling.
