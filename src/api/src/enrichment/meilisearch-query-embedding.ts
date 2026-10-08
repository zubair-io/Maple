/**
 * Query embeddings for hybrid search, computed by Maple rather than by
 * Meilisearch (#4437).
 *
 * Left to itself, Meilisearch embeds every hybrid query by calling Ollama with
 * no `keep_alive`, so the model unloads after Ollama's five idle minutes. The
 * next query then waits on a cold load (3.9 s measured for bge-m3) that
 * Meilisearch gives up on after about 1.5 s, silently answering keyword-only.
 *
 * Maple instead embeds the query through the same Ollama endpoint and model
 * the index embedder uses, asks Ollama to keep the model loaded, remembers the
 * vector per query text, and hands it to Meilisearch. When the embedding is
 * not back within a tight deadline the search runs keyword-only straight away
 * — the answer Meilisearch would have reached, without the wait — while the
 * embedding finishes in the background and warms the model and the cache for
 * the next query.
 *
 * A vector is only comparable with the index's stored vectors when it comes
 * from the same model, so Maple supplies one only after confirming that the
 * live index embedder is the configured one. Otherwise Meilisearch embeds the
 * query itself, exactly as before.
 */

import { child as childLogger } from '../log.ts';
import {
  joinMeilisearchUrl,
  meilisearchHttp,
  type MeilisearchTransportConfig,
} from './meilisearch-transport.ts';

const log = childLogger('enrichment:meilisearch:query-embedding');

/** Warm embeds measured 0.25 s and cold ones 3.9 s, and Meilisearch's own
 * fallback lands after about 1.5 s. 800 ms leaves a warm model three times its
 * usual latency to absorb queueing behind other work on a shared Ollama host,
 * yet never waits out a cold load, and always answers sooner than letting
 * Meilisearch time out would. */
const QUERY_EMBED_DEADLINE_MS = 800;

/** The embed keeps running past the deadline to warm the model; this only
 * stops a hung Ollama host from holding the request forever. Comfortably
 * above the measured 3.9 s cold load. */
const QUERY_EMBED_CEILING_MS = 30_000;

/** How long Ollama keeps the model loaded after each query. A day bridges the
 * gaps between search sessions, overnight included. Holding it costs nothing
 * the host needs back: Ollama unloads an idle model early when another model
 * needs the memory, so describe work is never blocked by it. */
const QUERY_EMBED_KEEP_ALIVE = '24h';

/** bge-m3 vectors are 1024 numbers, so 256 cached queries are a few MB. */
const QUERY_VECTOR_CACHE_ENTRIES = 256;

/** How long one reading of the live index embedder is trusted. The embedder
 * only changes when an operator saves new settings. */
const EMBEDDER_CHECK_TTL_MS = 60_000;

/** How a search should use semantic ranking. */
export type HybridQuery =
  | { kind: 'keyword-only' }
  | { kind: 'meili-embeds' }
  | { kind: 'vector'; vector: number[] };

export const KEYWORD_ONLY: HybridQuery = { kind: 'keyword-only' };
const MEILI_EMBEDS: HybridQuery = { kind: 'meili-embeds' };

export interface QueryEmbeddingConfig extends MeilisearchTransportConfig {
  indexName: string;
  embedderUrl: string;
  embedderModel: string;
  queryEmbedDeadlineMs?: number;
}

export interface QueryEmbedder {
  hybridQuery(text: string): Promise<HybridQuery>;
}

// Shared across client rebuilds: saving unrelated settings must not throw the
// warm vectors away. The key carries the endpoint and model, so a changed
// embedder never reuses another model's vectors.
const vectorCache = new Map<string, number[]>();
const pendingEmbeds = new Map<string, Promise<number[]>>();

function normalisedQuery(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function cachedVector(key: string): number[] | undefined {
  const vector = vectorCache.get(key);
  if (vector === undefined) return undefined;
  vectorCache.delete(key);
  vectorCache.set(key, vector);
  return vector;
}

function rememberVector(key: string, vector: number[]): void {
  vectorCache.delete(key);
  vectorCache.set(key, vector);
  const oldest = vectorCache.keys().next().value;
  if (vectorCache.size > QUERY_VECTOR_CACHE_ENTRIES && oldest !== undefined) {
    vectorCache.delete(oldest);
  }
}

function firstEmbedding(body: unknown): number[] | null {
  const embeddings = (body as { embeddings?: unknown } | null)?.embeddings;
  const first: unknown = Array.isArray(embeddings) ? embeddings[0] : undefined;
  return Array.isArray(first) &&
    first.length > 0 &&
    first.every((value) => typeof value === 'number' && Number.isFinite(value))
    ? (first as number[])
    : null;
}

async function requestEmbedding(config: QueryEmbeddingConfig, input: string): Promise<number[]> {
  const response = await config.fetchImpl(joinMeilisearchUrl(config.embedderUrl, '/api/embed'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.embedderModel,
      input,
      keep_alive: QUERY_EMBED_KEEP_ALIVE,
    }),
    signal: AbortSignal.timeout(QUERY_EMBED_CEILING_MS),
  });
  if (!response.ok) throw new Error(`ollama embed answered ${response.status}`);
  const vector = firstEmbedding(await response.json());
  if (vector === null) throw new Error('ollama embed returned no embedding');
  return vector;
}

/** One embed per query text at a time: the list and facets requests a search
 * page fires together share a single Ollama call. */
function sharedEmbedding(config: QueryEmbeddingConfig, key: string, input: string) {
  const pending = pendingEmbeds.get(key);
  if (pending !== undefined) return pending;
  const started = requestEmbedding(config, input)
    .then((vector) => {
      rememberVector(key, vector);
      return vector;
    })
    .finally(() => pendingEmbeds.delete(key));
  pendingEmbeds.set(key, started);
  return started;
}

async function beforeDeadline<T>(work: Promise<T>, ms: number): Promise<T | 'deadline'> {
  const timer: { id?: ReturnType<typeof setTimeout> } = {};
  const deadline = new Promise<'deadline'>((resolve) => {
    timer.id = setTimeout(() => resolve('deadline'), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer.id);
  }
}

/** Whether the live index embedder is the configured Ollama endpoint and
 * model, or null when Meilisearch could not be asked. */
async function liveEmbedderMatches(
  config: QueryEmbeddingConfig,
  embedderName: string,
): Promise<boolean | null> {
  const result = await meilisearchHttp<
    Record<string, { source?: string; model?: string; url?: string }>
  >(config, 'GET', `/indexes/${config.indexName}/settings/embedders`);
  if (!result.ok) return null;
  const live = result.body?.[embedderName];
  return (
    live?.source === 'ollama' &&
    live.model === config.embedderModel &&
    live.url === joinMeilisearchUrl(config.embedderUrl, '/api/embed')
  );
}

/**
 * Whether this client's vectors are comparable with the index's. A `true`
 * from the client's own settings sync (#4432) is trusted outright. Its `null`
 * (this client has not synced yet, as after a settings save) and its `false`
 * (which nothing in this process re-checks once an operator-applied re-embed
 * finishes) are settled by reading the live embedder instead.
 */
function embedderCheck(
  config: QueryEmbeddingConfig,
  embedderName: string,
  embedderInSync: () => boolean | null,
) {
  const reading: { matches?: boolean; at?: number } = {};
  return async (): Promise<boolean | null> => {
    if (embedderInSync() === true) return true;
    const fresh = reading.at !== undefined && Date.now() - reading.at < EMBEDDER_CHECK_TTL_MS;
    if (fresh) return reading.matches!;
    const matches = await liveEmbedderMatches(config, embedderName);
    if (matches !== null) Object.assign(reading, { matches, at: Date.now() });
    return matches;
  };
}

async function embeddedQuery(config: QueryEmbeddingConfig, text: string): Promise<HybridQuery> {
  const input = normalisedQuery(text);
  if (input.length === 0) return MEILI_EMBEDS;
  const key = `${config.embedderUrl}\u0000${config.embedderModel}\u0000${input}`;
  const hit = cachedVector(key);
  if (hit !== undefined) return { kind: 'vector', vector: hit };

  const embedding = sharedEmbedding(config, key, input);
  const deadlineMs = config.queryEmbedDeadlineMs ?? QUERY_EMBED_DEADLINE_MS;
  try {
    const vector = await beforeDeadline(embedding, deadlineMs);
    if (vector !== 'deadline') return { kind: 'vector', vector };
    log.info(
      { model: config.embedderModel, deadlineMs },
      'query embedding is slow; searching keyword-only while the model warms',
    );
    embedding.catch((err: unknown) =>
      log.warn(
        { model: config.embedderModel, err: err instanceof Error ? err.message : String(err) },
        'background query embedding failed',
      ),
    );
    return KEYWORD_ONLY;
  } catch (err) {
    log.warn(
      { model: config.embedderModel, err: err instanceof Error ? err.message : String(err) },
      'query embedding failed; searching keyword-only',
    );
    return KEYWORD_ONLY;
  }
}

/**
 * The query embedder for one client configuration. Call `hybridQuery` only
 * for a search that should be hybrid; keyword searches never touch Ollama.
 */
export function createQueryEmbedder(
  config: QueryEmbeddingConfig,
  embedderName: string,
  embedderInSync: () => boolean | null,
): QueryEmbedder {
  const embedderMatches = embedderCheck(config, embedderName, embedderInSync);
  return {
    async hybridQuery(text: string): Promise<HybridQuery> {
      return (await embedderMatches()) === true ? embeddedQuery(config, text) : MEILI_EMBEDS;
    },
  };
}
