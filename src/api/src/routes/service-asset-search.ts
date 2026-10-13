/**
 * `POST /api/search/assets` — the service-API search surface.
 *
 * A hybrid request asks the in-process engine first (`service-asset-search-in-process.ts`) and
 * falls back to the database when it cannot answer: `serviceLexicalSearch` in
 * `db/repos/search.service.ts`, an exact-filename pass followed by a ranked FTS5 pass. A lexical
 * request goes straight to the database.
 *
 * The database path answers two questions better than the query it replaced. Media type is a
 * stored column set by the indexer from the actual file, rather than a regex over the extension
 * lists matched against a filename — so a `.mov` renamed to `.mp4` is no longer classified by
 * its name. And a malformed query can no longer throw: every term is quoted into the FTS5
 * expression, so there is no syntax error left to swallow.
 */

import { Elysia } from 'elysia';
import { authenticateServiceApiKey, type ServiceApiIdentity } from '../auth/service-api-keys.ts';
import { serviceLexicalSearch } from '../db/repos/search.repo.ts';
import type { ServiceMediaType } from '../db/repos/search.service.ts';
import {
  consumeServiceSearchRateLimit,
  resetServiceSearchRateLimitsForTests,
} from '../enrichment/service-search-rate-limit.ts';
import { child as childLogger } from '../log.ts';
import {
  inProcessServiceSearch,
  type ServiceSearchResult,
} from './service-asset-search-in-process.ts';

const log = childLogger('service-search');
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type SearchMode = 'hybrid' | 'lexical';
type FallbackReason = 'search_engine_unavailable';

interface SearchRequestBody {
  query: string;
  mode?: SearchMode;
  limit?: number;
  includeHidden?: boolean;
  from?: string;
  to?: string;
  filters?: { mediaTypes?: ServiceMediaType[] };
}

function validMode(value: unknown): value is SearchMode | undefined {
  return value === undefined || value === 'hybrid' || value === 'lexical';
}

function validLimit(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_LIMIT)
  );
}

function parseUtcDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : parsed;
}

/** A bound is valid when it is absent, or present and a real calendar date. */
function validDateBound(value: unknown): boolean {
  return value === undefined || parseUtcDate(value) !== null;
}

function validDateRange(from: unknown, to: unknown): boolean {
  if (!validDateBound(from) || !validDateBound(to)) return false;
  const parsedFrom = parseUtcDate(from);
  const parsedTo = parseUtcDate(to);
  return !parsedFrom || !parsedTo || parsedFrom.getTime() <= parsedTo.getTime();
}

function validFilters(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const mediaTypes = (value as Record<string, unknown>).mediaTypes;
  if (mediaTypes === undefined) return true;
  const allowed = new Set(['image', 'video', 'audio']);
  return (
    Array.isArray(mediaTypes) &&
    mediaTypes.length >= 1 &&
    mediaTypes.length <= 3 &&
    mediaTypes.every((item) => typeof item === 'string' && allowed.has(item))
  );
}

function requestRecord(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
}

function validQuery(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 500;
}

function validHidden(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function parseSearchBody(body: unknown): SearchRequestBody | null {
  const candidate = requestRecord(body);
  if (!candidate) return null;
  if (!validQuery(candidate.query)) return null;
  if (!validMode(candidate.mode)) return null;
  if (!validLimit(candidate.limit)) return null;
  if (!validDateRange(candidate.from, candidate.to)) return null;
  if (!validHidden(candidate.includeHidden)) return null;
  if (!validFilters(candidate.filters)) return null;
  return candidate as unknown as SearchRequestBody;
}

export function _resetServiceSearchRateLimitsForTests(): void {
  resetServiceSearchRateLimitsForTests();
}

/** The parts of a search request that narrow the database fallback query.
 * `SearchContext` satisfies this structurally. */
interface DatabaseFilterScope {
  includeHidden: boolean;
  mediaTypes: ServiceMediaType[] | undefined;
  capturedFrom: string | undefined;
  capturedBefore: string | undefined;
}

/**
 * The database search, in the shape the rest of this route expects.
 *
 * `estimatedTotal` is the number of ids returned, exactly as it was before:
 * the fallback never counted past the page it built, and reporting a
 * larger-than-delivered total is the failure mode this route has to avoid.
 */
async function databaseLexicalSearch(
  scope: DatabaseFilterScope,
  query: string,
  limit: number,
): Promise<ServiceSearchResult & { exactIds: Set<string> }> {
  const hits = await serviceLexicalSearch(scope, query, limit);
  return { ids: hits.ids, estimatedTotal: hits.ids.length, exactIds: hits.exactIds };
}

function responseHits(result: ServiceSearchResult, exactIds: ReadonlySet<string> = new Set()) {
  return result.ids.map((assetId) => ({
    assetId,
    score: result.scores?.[assetId] ?? null,
    ...(exactIds.has(assetId) ? { matchedBy: ['exact_filename'] } : {}),
  }));
}

function audit(
  identity: ServiceApiIdentity,
  fields: {
    modeRequested: SearchMode;
    modeUsed: SearchMode;
    fallbackReason: FallbackReason | null;
    resultCount: number;
    durationMs: number;
  },
): void {
  log.info(
    {
      keyId: identity.keyId,
      keyPrefix: identity.prefix,
      ...fields,
    },
    'service asset search',
  );
}

function finishSearch(
  identity: ServiceApiIdentity,
  startedAt: number,
  modeRequested: SearchMode,
  modeUsed: SearchMode,
  fallbackReason: FallbackReason | null,
  result: ServiceSearchResult,
  exactIds: ReadonlySet<string> = new Set(),
) {
  audit(identity, {
    modeRequested,
    modeUsed,
    fallbackReason,
    resultCount: result.ids.length,
    durationMs: Math.round(performance.now() - startedAt),
  });
  return {
    modeRequested,
    modeUsed,
    fallbackReason,
    results: responseHits(result, exactIds),
    total: result.estimatedTotal,
    ...(result.more === undefined ? {} : { more: result.more, capped: result.capped }),
  };
}

interface SearchContext {
  query: string;
  modeRequested: SearchMode;
  limit: number;
  includeHidden: boolean;
  mediaTypes: ServiceMediaType[] | undefined;
  capturedFrom: string | undefined;
  capturedBefore: string | undefined;
}

function searchContext(request: SearchRequestBody): SearchContext {
  const capturedFrom = request.from ? parseUtcDate(request.from)!.toISOString() : undefined;
  const capturedBeforeDate = request.to ? parseUtcDate(request.to)! : null;
  capturedBeforeDate?.setUTCDate(capturedBeforeDate.getUTCDate() + 1);
  return {
    query: request.query.trim(),
    modeRequested: request.mode ?? 'hybrid',
    limit: request.limit ?? DEFAULT_LIMIT,
    includeHidden: request.includeHidden ?? false,
    mediaTypes: request.filters?.mediaTypes,
    capturedFrom,
    capturedBefore: capturedBeforeDate?.toISOString(),
  };
}

async function executeSearch(
  request: SearchRequestBody,
  identity: ServiceApiIdentity,
  startedAt: number,
) {
  const context = searchContext(request);
  const hybrid = context.modeRequested === 'hybrid';
  const inProcess = hybrid
    ? await inProcessServiceSearch(context, context.query, context.limit)
    : null;
  if (inProcess) return finishSearch(identity, startedAt, 'hybrid', 'hybrid', null, inProcess);

  const result = await databaseLexicalSearch(context, context.query, context.limit);
  return finishSearch(
    identity,
    startedAt,
    context.modeRequested,
    'lexical',
    hybrid ? 'search_engine_unavailable' : null,
    result,
    result.exactIds,
  );
}

export const serviceAssetSearchRoutes = new Elysia({
  name: 'serviceAssetSearchRoutes',
}).post('/api/search/assets', async ({ body, request, set }) => {
  const startedAt = performance.now();
  const auth = await authenticateServiceApiKey(
    request.headers.get('authorization'),
    'assets:search',
  );
  if (!auth.ok) {
    set.status = auth.status;
    return { error: auth.reason };
  }
  const parsed = parseSearchBody(body);
  if (!parsed) {
    set.status = 400;
    return { error: 'invalid_request_body' };
  }
  const rate = await consumeServiceSearchRateLimit(auth.identity.keyId);
  if (!rate.allowed) {
    set.status = 429;
    set.headers['retry-after'] = String(rate.retryAfterSeconds);
    return { error: 'rate_limit_exceeded', retryAfterSeconds: rate.retryAfterSeconds };
  }

  if (parsed.query.trim().length === 0) {
    set.status = 400;
    return { error: 'query_must_not_be_empty' };
  }
  return executeSearch(parsed, auth.identity, startedAt);
});
