/**
 * /api/search — EXIF-focused photo search across one or all libraries.
 *
 * Endpoints:
 *   GET /api/search          — paginated result list
 *   GET /api/search/facets   — aggregation buckets for FE dropdowns
 *   GET /api/search/buckets  — year/month histogram for the Timeline view
 *
 * The route lives behind `requireAuth`, so it is registered after that
 * middleware in `src/index.ts`.
 *
 * The data layer lives in `db/repos/search.repo.ts`: these three
 * handlers translate the query string once with `buildSearchWhere` and hand
 * the result to `searchPage`/`searchCount`, `searchFacets` and
 * `searchBuckets`. Nothing here composes SQL.
 *
 * Internal module layout (see neighbours):
 *   - `query.ts`   — query schema and the shared parsing helpers
 *   - `sort.ts`    — the sort tokens the wire accepts
 *   - `project.ts` — wire-shape projection (`AssetDoc` → `SearchResult`)
 *   - `libraries.ts`   — the library root + slug maps the projection needs
 *   - `list.ts`    — `GET /`
 *   - `list-meili.ts`  — the Meilisearch branch + its database fallback
 *   - `list-paging.ts` — skip-vs-seek mode resolution for `GET /`
 *   - `cursor.ts`  — the seek cursor's shape and validation (#2129)
 *   - `total-cache.ts` — 30s `total` count cache for `GET /`
 *   - `facets.ts`  — `GET /facets`
 *   - `buckets.ts` — `GET /buckets` + response cache
 */

import { Elysia } from 'elysia';
import { listRoute } from './list.ts';
import { facetsRoute } from './facets.ts';
import { bucketsRoute } from './buckets.ts';

export { _resetBucketsCacheForTests } from './buckets.ts';
export { _resetCacheForTests } from './total-cache.ts';
export type { SearchQuery } from './query.ts';
export type { SearchResult, SearchResultPHLink } from './project.ts';

export const searchRoutes = new Elysia({ prefix: '/api/search' })
  .use(listRoute)
  .use(facetsRoute)
  .use(bucketsRoute);
