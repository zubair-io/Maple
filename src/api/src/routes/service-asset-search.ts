import { Elysia, t } from 'elysia';
import type { Filter } from 'mongodb';
import { authenticateServiceApiKey, type ServiceApiIdentity } from '../auth/service-api-keys.ts';
import { assetsCollection } from '../db/client.ts';
import type { AssetDoc } from '../db/schema.ts';
import {
  meilisearchClient,
  type MeilisearchMediaType,
  type MeilisearchSearchResult,
} from '../enrichment/meilisearch-client.ts';
import { AUDIO_EXTS, VIDEO_EXTS } from '../indexer/media-types.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('service-search');
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_RATE_LIMIT = 60;

type SearchMode = 'hybrid' | 'lexical';
type FallbackReason =
  | 'semantic_not_configured'
  | 'semantic_embedder_unavailable'
  | 'meilisearch_unavailable'
  | 'meilisearch_query_failed';

const SearchBody = t.Object({
  query: t.String({ minLength: 1, maxLength: 500 }),
  mode: t.Optional(t.Union([t.Literal('hybrid'), t.Literal('lexical')])),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_LIMIT })),
  includeHidden: t.Optional(t.Boolean()),
  filters: t.Optional(
    t.Object({
      mediaTypes: t.Optional(
        t.Array(t.Union([t.Literal('image'), t.Literal('video'), t.Literal('audio')]), {
          minItems: 1,
          maxItems: 3,
        }),
      ),
    }),
  ),
});

interface RateWindow {
  startedAt: number;
  count: number;
}

const rateWindows = new Map<string, RateWindow>();

export function _resetServiceSearchRateLimitsForTests(): void {
  rateWindows.clear();
}

function rateLimitPerMinute(): number {
  const configured = Number(process.env.MAPLE_SERVICE_SEARCH_RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(configured) && configured > 0
    ? Math.trunc(configured)
    : DEFAULT_RATE_LIMIT;
}

function consumeRateLimit(keyId: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const window = rateWindows.get(keyId);
  if (!window || now - window.startedAt >= 60_000) {
    rateWindows.set(keyId, { startedAt: now, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (window.count >= rateLimitPerMinute()) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (now - window.startedAt)) / 1000)),
    };
  }
  window.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

function isSecureServiceRequest(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === 'https';
  const url = new URL(request.url);
  if (url.protocol === 'https:') return true;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mediaFilenameRegex(mediaTypes: MeilisearchMediaType[] | undefined): RegExp | null {
  if (!mediaTypes || mediaTypes.length === 0 || mediaTypes.length === 3) return null;
  const include = new Set(mediaTypes);
  const video = [...VIDEO_EXTS].map((ext) => regexEscape(ext));
  const audio = [...AUDIO_EXTS].map((ext) => regexEscape(ext));
  if (include.size === 1 && include.has('image')) {
    return new RegExp(`^(?!.*(?:${[...video, ...audio].join('|')})$).*`, 'i');
  }
  const extensions: string[] = [];
  if (include.has('video')) extensions.push(...video);
  if (include.has('audio')) extensions.push(...audio);
  if (include.has('image')) {
    // Mixed image + one non-image type is easiest to express as excluding the
    // one media family that was not requested.
    const excluded = include.has('video') ? audio : video;
    return new RegExp(`^(?!.*(?:${excluded.join('|')})$).*`, 'i');
  }
  return new RegExp(`(?:${extensions.join('|')})$`, 'i');
}

function mongoBaseFilter(
  includeHidden: boolean,
  mediaTypes: MeilisearchMediaType[] | undefined,
): Filter<AssetDoc> {
  const entry: Record<string, unknown> = {
    deleted_at: { $in: [null] },
    missing_since: { $in: [null] },
  };
  const filenameRegex = mediaFilenameRegex(mediaTypes);
  if (filenameRegex) entry.filename = filenameRegex;
  return {
    deleted_at: { $in: [null] },
    ...(includeHidden ? {} : { hidden: { $ne: true } }),
    fileinfo: { $elemMatch: entry },
  } as Filter<AssetDoc>;
}

async function mongoLexicalSearch(
  query: string,
  limit: number,
  includeHidden: boolean,
  mediaTypes: MeilisearchMediaType[] | undefined,
): Promise<MeilisearchSearchResult & { exactIds: Set<string> }> {
  const coll = await assetsCollection();
  const base = mongoBaseFilter(includeHidden, mediaTypes);
  const exactFilename = new RegExp(`^${regexEscape(query)}$`, 'i');
  const exactRows = await coll
    .find({ ...base, 'fileinfo.filename': exactFilename } as Filter<AssetDoc>)
    .project<{ maple_id?: string }>({ maple_id: 1 })
    .limit(limit)
    .toArray();
  const ids = exactRows
    .map((row) => row.maple_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const exactIds = new Set(ids);

  if (ids.length < limit) {
    try {
      const textRows = await coll
        .find({ ...base, $text: { $search: query } } as Filter<AssetDoc>)
        .project<{ maple_id?: string; score?: number }>({
          maple_id: 1,
          score: { $meta: 'textScore' },
        })
        .sort({ score: { $meta: 'textScore' } })
        .limit(limit)
        .toArray();
      for (const row of textRows) {
        if (typeof row.maple_id === 'string' && !ids.includes(row.maple_id)) {
          ids.push(row.maple_id);
          if (ids.length >= limit) break;
        }
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'mongo text fallback failed; returning exact filename matches only',
      );
    }
  }
  return { ids, estimatedTotal: ids.length, exactIds };
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

export const serviceAssetSearchRoutes = new Elysia({
  name: 'serviceAssetSearchRoutes',
}).post(
  '/api/search/assets',
  async ({ body, request, set }) => {
    const startedAt = performance.now();
    if (!isSecureServiceRequest(request)) {
      set.status = 400;
      return { error: 'tls_required' };
    }

    const auth = await authenticateServiceApiKey(
      request.headers.get('authorization'),
      'assets:search',
    );
    if (!auth.ok) {
      set.status = auth.status;
      return { error: auth.reason };
    }
    const rate = consumeRateLimit(auth.identity.keyId);
    if (!rate.allowed) {
      set.status = 429;
      set.headers['retry-after'] = String(rate.retryAfterSeconds);
      return { error: 'rate_limit_exceeded', retryAfterSeconds: rate.retryAfterSeconds };
    }

    const query = body.query.trim();
    if (query.length === 0) {
      set.status = 400;
      return { error: 'query_must_not_be_empty' };
    }
    const modeRequested: SearchMode = body.mode ?? 'hybrid';
    const limit = body.limit ?? DEFAULT_LIMIT;
    const includeHidden = body.includeHidden ?? false;
    const mediaTypes = body.filters?.mediaTypes;
    const meili = meilisearchClient();
    let fallbackReason: FallbackReason | null = null;

    if (meili.isConfigured()) {
      if (modeRequested === 'hybrid' && meili.semanticConfigured()) {
        try {
          const result = await meili.search(query, {
            semantic: true,
            limit,
            includeHidden,
            mediaTypes,
          });
          audit(auth.identity, {
            modeRequested,
            modeUsed: 'hybrid',
            fallbackReason: null,
            resultCount: result.ids.length,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return {
            modeRequested,
            modeUsed: 'hybrid' as const,
            fallbackReason: null,
            results: responseHits(result),
            total: result.estimatedTotal,
          };
        } catch (err) {
          fallbackReason = 'semantic_embedder_unavailable';
          log.warn(
            {
              keyId: auth.identity.keyId,
              err: err instanceof Error ? err.message : String(err),
            },
            'hybrid query failed; retrying lexical',
          );
        }
      } else if (modeRequested === 'hybrid') {
        fallbackReason = 'semantic_not_configured';
      }

      try {
        const result = await meili.search(query, {
          semantic: false,
          limit,
          includeHidden,
          mediaTypes,
        });
        audit(auth.identity, {
          modeRequested,
          modeUsed: 'lexical',
          fallbackReason,
          resultCount: result.ids.length,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return {
          modeRequested,
          modeUsed: 'lexical' as const,
          fallbackReason,
          results: responseHits(result),
          total: result.estimatedTotal,
        };
      } catch (err) {
        fallbackReason = fallbackReason ?? 'meilisearch_query_failed';
        log.warn(
          { keyId: auth.identity.keyId, err: err instanceof Error ? err.message : String(err) },
          'meilisearch lexical query failed; falling back to mongo',
        );
      }
    } else {
      fallbackReason = 'meilisearch_unavailable';
    }

    const result = await mongoLexicalSearch(query, limit, includeHidden, mediaTypes);
    audit(auth.identity, {
      modeRequested,
      modeUsed: 'lexical',
      fallbackReason,
      resultCount: result.ids.length,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return {
      modeRequested,
      modeUsed: 'lexical' as const,
      fallbackReason,
      results: responseHits(result, result.exactIds),
      total: result.estimatedTotal,
    };
  },
  { body: SearchBody },
);
