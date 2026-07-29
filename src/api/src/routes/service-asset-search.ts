import { Elysia } from 'elysia';
import type { Collection, Filter } from 'mongodb';
import { authenticateServiceApiKey, type ServiceApiIdentity } from '../auth/service-api-keys.ts';
import { assetsCollection } from '../db/client.ts';
import type { AssetDoc } from '../db/schema.ts';
import {
  MeilisearchSearchError,
  meilisearchClient,
  type MeilisearchFailureDetails,
  type MeilisearchMediaType,
  type MeilisearchSearchResult,
} from '../enrichment/meilisearch-client.ts';
import {
  consumeServiceSearchRateLimit,
  resetServiceSearchRateLimitsForTests,
} from '../enrichment/service-search-rate-limit.ts';
import { AUDIO_EXTS, VIDEO_EXTS } from '../indexer/media-types.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('service-search');
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type SearchMode = 'hybrid' | 'lexical';
type FallbackReason =
  | 'semantic_not_configured'
  | 'semantic_embedder_unavailable'
  | 'meilisearch_unavailable'
  | 'meilisearch_query_failed';

interface SearchRequestBody {
  query: string;
  mode?: SearchMode;
  limit?: number;
  includeHidden?: boolean;
  from?: string;
  to?: string;
  filters?: { mediaTypes?: MeilisearchMediaType[] };
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

function validDateRange(from: unknown, to: unknown): boolean {
  if (from === undefined && to === undefined) return true;
  const parsedFrom = from === undefined ? null : parseUtcDate(from);
  const parsedTo = to === undefined ? null : parseUtcDate(to);
  if (from !== undefined && !parsedFrom) return false;
  if (to !== undefined && !parsedTo) return false;
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

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function imageFilenameRegex(
  include: ReadonlySet<MeilisearchMediaType>,
  video: string[],
  audio: string[],
): RegExp | null {
  if (!include.has('image')) return null;
  if (include.size === 1 && include.has('image')) {
    return new RegExp(`^(?!.*(?:${[...video, ...audio].join('|')})$).*`, 'i');
  }
  const excluded = include.has('video') ? audio : video;
  return new RegExp(`^(?!.*(?:${excluded.join('|')})$).*`, 'i');
}

function mediaFilenameRegex(mediaTypes: MeilisearchMediaType[] | undefined): RegExp | null {
  if (!mediaTypes || mediaTypes.length === 0 || mediaTypes.length === 3) return null;
  const include = new Set(mediaTypes);
  const video = [...VIDEO_EXTS].map(regexEscape);
  const audio = [...AUDIO_EXTS].map(regexEscape);
  const image = imageFilenameRegex(include, video, audio);
  if (image) return image;
  const extensions = [
    ...(include.has('video') ? video : []),
    ...(include.has('audio') ? audio : []),
  ];
  return new RegExp(`(?:${extensions.join('|')})$`, 'i');
}

function mongoBaseFilter(
  includeHidden: boolean,
  mediaTypes: MeilisearchMediaType[] | undefined,
  capturedFrom?: string,
  capturedBefore?: string,
  exactFilename?: RegExp,
): Filter<AssetDoc> {
  const entry: Record<string, unknown> = {
    deleted_at: { $in: [null] },
    missing_since: { $in: [null] },
  };
  const filenameRegex = mediaFilenameRegex(mediaTypes);
  if (filenameRegex && exactFilename) {
    entry.$and = [{ filename: filenameRegex }, { filename: exactFilename }];
  } else if (filenameRegex) {
    entry.filename = filenameRegex;
  } else if (exactFilename) {
    entry.filename = exactFilename;
  }
  return {
    deleted_at: { $in: [null] },
    ...(includeHidden ? {} : { hidden: { $ne: true } }),
    ...(capturedFrom || capturedBefore
      ? {
          'exif.captured_at': {
            ...(capturedFrom ? { $gte: capturedFrom } : {}),
            ...(capturedBefore ? { $lt: capturedBefore } : {}),
          },
        }
      : {}),
    fileinfo: { $elemMatch: entry },
  } as Filter<AssetDoc>;
}

async function mongoLexicalSearch(
  query: string,
  limit: number,
  includeHidden: boolean,
  mediaTypes: MeilisearchMediaType[] | undefined,
  capturedFrom?: string,
  capturedBefore?: string,
): Promise<MeilisearchSearchResult & { exactIds: Set<string> }> {
  const coll = await assetsCollection();
  const base = mongoBaseFilter(includeHidden, mediaTypes, capturedFrom, capturedBefore);
  const exactFilename = new RegExp(`^${regexEscape(query)}$`, 'i');
  const exactRows = await coll
    .find(mongoBaseFilter(includeHidden, mediaTypes, capturedFrom, capturedBefore, exactFilename))
    .project<{ maple_id?: string }>({ maple_id: 1 })
    .limit(limit)
    .toArray();
  const ids = exactRows
    .map((row) => row.maple_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const exactIds = new Set(ids);

  if (ids.length < limit) await appendMongoTextMatches(coll, base, query, limit, ids);
  return { ids, estimatedTotal: ids.length, exactIds };
}

async function appendMongoTextMatches(
  coll: Collection<AssetDoc>,
  base: Filter<AssetDoc>,
  query: string,
  limit: number,
  ids: string[],
): Promise<void> {
  try {
    const rows = await coll
      .find({ ...base, $text: { $search: query } } as Filter<AssetDoc>)
      .project<{ maple_id?: string; score?: number }>({
        maple_id: 1,
        score: { $meta: 'textScore' },
      })
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .toArray();
    for (const row of rows) {
      if (typeof row.maple_id !== 'string' || ids.includes(row.maple_id)) continue;
      ids.push(row.maple_id);
      if (ids.length >= limit) return;
    }
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'mongo text fallback failed; returning exact filename matches only',
    );
  }
}

function responseHits(result: MeilisearchSearchResult, exactIds: ReadonlySet<string> = new Set()) {
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
  result: MeilisearchSearchResult,
  fallbackDetails: MeilisearchFailureDetails | null = null,
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
    fallbackDetails,
    results: responseHits(result, exactIds),
    total: result.estimatedTotal,
  };
}

type CompletedSearch = ReturnType<typeof finishSearch>;

interface SearchContext {
  query: string;
  modeRequested: SearchMode;
  limit: number;
  includeHidden: boolean;
  mediaTypes: MeilisearchMediaType[] | undefined;
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

function meiliOptions(context: SearchContext, semantic: boolean) {
  return {
    semantic,
    limit: context.limit,
    includeHidden: context.includeHidden,
    mediaTypes: context.mediaTypes,
    capturedFrom: context.capturedFrom,
    capturedBefore: context.capturedBefore,
  };
}

async function tryHybridSearch(
  meili: ReturnType<typeof meilisearchClient>,
  context: SearchContext,
  identity: ServiceApiIdentity,
  startedAt: number,
): Promise<{
  response: CompletedSearch | null;
  fallback: FallbackReason | null;
  details: MeilisearchFailureDetails | null;
}> {
  if (context.modeRequested !== 'hybrid') {
    return { response: null, fallback: null, details: null };
  }
  if (!meili.semanticConfigured()) {
    return { response: null, fallback: 'semantic_not_configured', details: null };
  }
  try {
    const result = await meili.search(context.query, meiliOptions(context, true));
    return {
      response: finishSearch(identity, startedAt, context.modeRequested, 'hybrid', null, result),
      fallback: null,
      details: null,
    };
  } catch (error) {
    log.warn(
      { keyId: identity.keyId, err: error instanceof Error ? error.message : String(error) },
      'hybrid query failed; retrying lexical',
    );
    const details =
      error instanceof MeilisearchSearchError
        ? error.details
        : {
            status: null,
            code: null,
            type: null,
            message: error instanceof Error ? error.message : String(error),
          };
    return { response: null, fallback: 'semantic_embedder_unavailable', details };
  }
}

async function tryMeilisearchLexical(
  meili: ReturnType<typeof meilisearchClient>,
  context: SearchContext,
  identity: ServiceApiIdentity,
  startedAt: number,
  fallback: FallbackReason | null,
  fallbackDetails: MeilisearchFailureDetails | null,
): Promise<{
  response: CompletedSearch | null;
  fallback: FallbackReason | null;
  details: MeilisearchFailureDetails | null;
}> {
  try {
    const result = await meili.search(context.query, meiliOptions(context, false));
    return {
      response: finishSearch(
        identity,
        startedAt,
        context.modeRequested,
        'lexical',
        fallback,
        result,
        fallbackDetails,
      ),
      fallback,
      details: fallbackDetails,
    };
  } catch (error) {
    log.warn(
      { keyId: identity.keyId, err: error instanceof Error ? error.message : String(error) },
      'meilisearch lexical query failed; falling back to mongo',
    );
    const details =
      error instanceof MeilisearchSearchError
        ? error.details
        : {
            status: null,
            code: null,
            type: null,
            message: error instanceof Error ? error.message : String(error),
          };
    return { response: null, fallback: 'meilisearch_query_failed', details };
  }
}

async function executeSearch(
  request: SearchRequestBody,
  identity: ServiceApiIdentity,
  startedAt: number,
) {
  const context = searchContext(request);
  const meili = meilisearchClient();
  let fallbackReason: FallbackReason | null = null;
  let fallbackDetails: MeilisearchFailureDetails | null = null;

  if (meili.isConfigured()) {
    const hybrid = await tryHybridSearch(meili, context, identity, startedAt);
    if (hybrid.response) return hybrid.response;
    fallbackReason = hybrid.fallback;
    fallbackDetails = hybrid.details;
    const lexical = await tryMeilisearchLexical(
      meili,
      context,
      identity,
      startedAt,
      fallbackReason,
      fallbackDetails,
    );
    if (lexical.response) return lexical.response;
    fallbackReason = lexical.fallback;
    fallbackDetails = lexical.details;
  } else {
    fallbackReason = 'meilisearch_unavailable';
  }

  const result = await mongoLexicalSearch(
    context.query,
    context.limit,
    context.includeHidden,
    context.mediaTypes,
    context.capturedFrom,
    context.capturedBefore,
  );
  return finishSearch(
    identity,
    startedAt,
    context.modeRequested,
    'lexical',
    fallbackReason,
    result,
    fallbackDetails,
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
