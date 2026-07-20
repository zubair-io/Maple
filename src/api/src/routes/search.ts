/**
 * Compatibility shim — the implementation moved to `routes/search/`
 * after #126 split the 820-LOC file into per-endpoint modules. Existing
 * importers (`src/index.ts`, the test files) reach the route via this
 * path so the refactor stays internal.
 */

export {
  searchRoutes,
  buildFilter,
  _resetBucketsCacheForTests,
  _resetCacheForTests,
  type SearchQuery,
  type SearchResult,
  type SearchResultPHLink,
} from './search/index.ts';
