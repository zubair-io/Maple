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
 * Internal module layout (see neighbours):
 *   - `query.ts`   — query schema, `buildFilter`, `applyLiveFilter`, helpers
 *   - `sort.ts`    — `pickSort` for the list endpoint
 *   - `project.ts` — wire-shape projection (`AssetDoc` → `SearchResult`)
 *   - `list.ts`    — `GET /` (incl. Meilisearch fallback) + total-count cache
 *   - `facets.ts`  — `GET /facets`
 *   - `buckets.ts` — `GET /buckets` + response cache
 */

import { Elysia } from 'elysia';
import { listRoute } from './list.ts';
import { facetsRoute } from './facets.ts';
import { bucketsRoute } from './buckets.ts';

export { _resetBucketsCacheForTests } from './buckets.ts';
export { _resetCacheForTests } from './list.ts';
export { buildFilter } from './query.ts';
export type { SearchQuery } from './query.ts';
export type { SearchResult, SearchResultPHLink } from './project.ts';

export const searchRoutes = new Elysia({ prefix: '/api/search' })
  .use(listRoute)
  .use(facetsRoute)
  .use(bucketsRoute);
