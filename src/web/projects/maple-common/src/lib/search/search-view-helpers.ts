import { SearchParams } from '../api/search.service';
import { SearchFilters, filtersToParams } from './search-filters';

/** The filter panel docks on desktop and becomes a sheet on smaller screens. */
export function filterHostClass(open: boolean): string {
  const base =
    'fixed inset-x-0 bottom-0 z-[41] h-[78%] w-auto overflow-hidden rounded-t-2xl shadow-[0_-8px_32px_rgba(0,0,0,0.4)] lg:static lg:z-auto lg:h-auto lg:w-[320px] lg:shrink-0 lg:min-h-0 lg:overflow-visible lg:rounded-none lg:border-l lg:border-border lg:shadow-none';
  return open ? `${base} flex` : `${base} hidden lg:flex`;
}

/** Content text uses the ranked placeQuery path; filter-only searches can sort by date. */
export function buildSearchParams(
  text: string,
  filters: SearchFilters,
  sort: 'captured_desc' | 'captured_asc',
  paging: { page?: number; cursor?: string; rankPin?: string },
): SearchParams {
  return {
    ...(text.length > 0 ? { placeQuery: text } : {}),
    ...filtersToParams(filters),
    ...(text.length === 0 ? { sort } : {}),
    ...(paging.cursor !== undefined ? { cursor: paging.cursor } : { page: paging.page ?? 0 }),
    ...(paging.rankPin !== undefined ? { rankPin: paging.rankPin } : {}),
    limit: 30,
  };
}
