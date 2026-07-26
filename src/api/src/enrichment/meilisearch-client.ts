/**
 * Meilisearch sidecar client — typo-tolerant text search above the Mongo
 * `$text` index. See `docs/indexer-enrichment.md` §5.5 and Phase 7 brief.
 *
 * Maple is purely a client. Operators run Meilisearch elsewhere (Proxmox VM,
 * Docker, separate host) and point Maple at it via `MAPLE_MEILISEARCH_URL`.
 *
 * Behaviour:
 *   - When `MAPLE_MEILISEARCH_URL` is unset, every method is a no-op
 *     (returns success / empty). The route layer falls back to the Mongo
 *     `$text` path; the asset stays searchable, just without typo tolerance.
 *   - All non-`health` methods log-and-swallow on error. Failures must NOT
 *     break the geocode worker, the soft-delete path, or the search route.
 *     `health()` returns a boolean — callers decide what to do.
 *   - The explicit backfill route surfaces errors to the operator; that
 *     happens at the route level, not in this client.
 *
 * We deliberately implement the wire protocol with bare `fetch` rather than
 * adopting the `meilisearch` npm client's async-task awaiting. The wire is a
 * tiny REST surface (one POST per upsert, one GET per search), and avoiding
 * the package keeps the dependency footprint small AND makes mocking
 * (`globalThis.fetch`) the only seam tests need to control.
 */

import { child as childLogger } from '../log.ts';

const log = childLogger('enrichment:meilisearch');

/** The Meilisearch index name we manage. Single-tenant; one Maple deployment
 * gets one index regardless of how many libraries the user has registered. */
export const ASSETS_INDEX = 'assets';

/** Latest stable v1 features we rely on; bumped when we change the schema.
 * v3: adds filename/media/hidden fields and the operator-facing semantic
 * status surface. */
const REQUIRED_SETTINGS_VERSION = 3;

/** Default Ollama base URL — mirrors the describe worker's default
 * (`MAPLE_DESCRIBE_PROVIDER_URL`). Meilisearch reaches this host to embed
 * both documents and queries when semantic search is enabled. */
export const DEFAULT_EMBEDDER_BASE_URL = 'http://localhost:11434';
/** Default Ollama embedding model. `nomic-embed-text` is a small, fast,
 * widely-available text embedder. */
export const DEFAULT_EMBEDDER_MODEL = 'nomic-embed-text';
/** Default hybrid blend: 0.5 weights keyword and vector relevance equally. */
export const DEFAULT_SEMANTIC_RATIO = 0.5;
/** The Meili embedder name we register + reference in hybrid queries. */
export const EMBEDDER_NAME = 'caption';

export type MeilisearchMediaType = 'image' | 'video' | 'audio';

/** Document shape we push to Meilisearch. Mirror of the unified
 * `asset.search_blob` field plus the per-attribute sources so
 * Meilisearch can apply per-field weighting (POI/place metadata typically
 * outranks description prose, which outranks OCR'd UI chrome). */
export interface MeilisearchAssetDoc {
  /** Unique document id. We use the asset's stable `maple_id` so re-upserts
   * are idempotent even after rename/move (the absPath changes; mapleId
   * doesn't). */
  id: string;
  /** Primary filename. Kept as the highest-weight lexical field so exact
   * camera filenames remain strong even when hybrid search is enabled. */
  filename?: string;
  /** Unified text bag — concatenation of `place.search_blob`,
   * `description`, and `ocr_text`. Equivalent to what the Mongo `$text`
   * index covers. */
  searchBlob: string;
  /** LLM-generated caption from the describe worker (Phase 6). Stored
   * separately so per-attribute weighting can favour caption matches.
   * `null`/omitted before the worker has run. */
  description?: string | null;
  /** OCR'd text from the OCR worker (Phase 8). Same per-attribute
   * weighting story as `description`. */
  ocrText?: string | null;
  /** Folder hex string. Filterable so the route can scope to one library. */
  folderId: string;
  /** ISO timestamp; sortable so the future "search-as-you-type" path can
   * tie-break by recency. Null when EXIF is missing. */
  capturedAt: string | null;
  /** ISO timestamp when the asset was soft-deleted. Filterable so the
   * route can exclude `deletedAt IS NOT NULL`. We keep tombstones in-index
   * by setting this rather than `deleteDocument` so eventual-consistency
   * lag never resurrects a deleted row. */
  deletedAt: string | null;
  /** Closed-union scene classification from `vision.scene_type`. `null` on
   * rows that haven't been through the qwen2.5-vl describe stage yet. */
  visionSceneType?: string | null;
  /** Open-vocab activity tag from `vision.activity`. */
  visionActivity?: string | null;
  /** Open-vocab subject tags from `vision.subjects`. Array filterable so a
   * future meili-side facet path can intersect on subject. */
  visionSubjects?: string[] | null;
  /** Screenshot vs photograph — top-level mirror of `vision.is_screenshot`
   * (or the exif-stage heuristic when describe hasn't run yet). */
  isScreenshot?: boolean | null;
  /** Named people appearing in this asset — `PersonDoc.name`s resolved from
   * `faces[].person_id`, EXCLUDING auto-generated `Person N` clusters and
   * merged rows. Searchable (so "Greyson" matches) and filterable (so an
   * explicit picker can `people IN [...]`). `null`/omitted when the asset
   * has no named people. */
  people?: string[] | null;
  /** Coarse media class for service consumers such as SugarMaple. */
  mediaType?: MeilisearchMediaType;
  /** Effective hidden state. Filtered by default; service callers need an
   * explicit includeHidden=true request to retrieve hidden assets. */
  hidden?: boolean;
}

export interface MeilisearchSearchOptions {
  /** Hex folder id; passed through to Meilisearch's filter syntax. */
  folderId?: string;
  /** Person names to constrain results to (filterable `people IN [...]`).
   * Each value is escaped before injection. */
  people?: string[];
  /** Optional coarse media-type filter. */
  mediaTypes?: MeilisearchMediaType[];
  /** Hidden assets are excluded unless explicitly requested. */
  includeHidden?: boolean;
  /** When true, run a hybrid (keyword + vector) query against the managed
   * `caption` embedder. Ignored unless `semanticConfigured()` is true; the
   * route passes `meili.semanticConfigured()` so this is self-gating. */
  semantic?: boolean;
  /** Pagination. Defaults match the search route. */
  offset?: number;
  limit?: number;
}

export interface MeilisearchSearchResult {
  /** Asset ids in Meilisearch's relevance order. The route fetches asset
   * summaries from Mongo with `find({ maple_id: { $in: ids } })` and
   * preserves this order. */
  ids: string[];
  /** Meilisearch's `estimatedTotalHits` — what the route returns as `total`. */
  estimatedTotal: number;
  /** Ranking scores keyed by asset id when the Meilisearch version exposes
   * `_rankingScore`. Older servers omit it and callers return `null`. */
  scores?: Record<string, number>;
}

export interface MeilisearchSemanticStatus {
  configured: boolean;
  enabled: boolean;
  embedderName: string;
  model: string;
  semanticRatio: number;
  meilisearchReachable: boolean;
  embedderConfigured: boolean;
  embedderReachable: boolean;
  indexedDocumentCount: number | null;
  vectorizedDocumentCount: number | null;
  isIndexing: boolean | null;
  error: string | null;
}

export interface MeilisearchClient {
  /** Whether the client is configured (URL set in env). */
  isConfigured(): boolean;
  /** Whether semantic (hybrid vector) search is enabled — the master
   * switch is on AND the client is configured. The route passes this as
   * the `semantic` flag so hybrid is opt-in and degrades to keyword. */
  semanticConfigured(): boolean;
  /** Reachability check used at boot. Returns false on any error
   * (unconfigured, unreachable, 4xx, etc.) so the caller can warn-and-continue. */
  health(): Promise<boolean>;
  /** Idempotent index + settings creation. Safe to call on every boot. */
  ensureIndex(): Promise<void>;
  /** Fire-and-forget upsert. Errors are logged and swallowed. */
  upsert(doc: MeilisearchAssetDoc): Promise<void>;
  /** Like `upsert` but throws on non-2xx. Used by the meili stage so the
   * runtime retries on Meilisearch transport errors. */
  upsertOrThrow(doc: MeilisearchAssetDoc): Promise<void>;
  /** Bulk variant used by the resumable backfill to enqueue one Meilisearch
   * task per batch instead of one task per asset. */
  upsertBatchOrThrow?(docs: MeilisearchAssetDoc[]): Promise<void>;
  /** Mark a document tombstoned (sets `deletedAt`). The search route filters
   * `deletedAt IS NULL` so tombstoned docs disappear from results. */
  tombstone(id: string): Promise<void>;
  /** Typo-tolerant text search. Returns ids only; the route fetches the
   * full asset rows from Mongo. Throws on transport error so the route can
   * fall back to Mongo `$text`. */
  search(q: string, opts?: MeilisearchSearchOptions): Promise<MeilisearchSearchResult>;
  /** Operator-facing semantic configuration and vector coverage snapshot. */
  semanticStatus?(): Promise<MeilisearchSemanticStatus>;
}

interface ClientConfig {
  url: string | undefined;
  apiKey: string | undefined;
  /** Master switch for semantic/hybrid search. Default OFF so existing
   * deployments are unaffected and Meili↔Ollama coordination is opt-in. */
  semantic: boolean;
  /** Ollama base URL Meili embeds against. */
  embedderUrl: string;
  /** Ollama embedding model id. */
  embedderModel: string;
  /** Hybrid semantic ratio (0 = pure keyword, 1 = pure vector). */
  semanticRatio: number;
  fetchImpl: typeof fetch;
}

function readConfig(): ClientConfig {
  const ratioRaw = process.env.MAPLE_MEILISEARCH_SEMANTIC_RATIO?.trim();
  const ratio = ratioRaw !== undefined && ratioRaw.length > 0 ? Number(ratioRaw) : NaN;
  return {
    url: process.env.MAPLE_MEILISEARCH_URL?.trim() || undefined,
    apiKey: process.env.MAPLE_MEILISEARCH_API_KEY?.trim() || undefined,
    semantic: process.env.MAPLE_MEILISEARCH_SEMANTIC?.trim() === 'true',
    embedderUrl:
      process.env.MAPLE_MEILISEARCH_EMBEDDER_URL?.trim() ||
      process.env.MAPLE_DESCRIBE_PROVIDER_URL?.trim() ||
      DEFAULT_EMBEDDER_BASE_URL,
    embedderModel: process.env.MAPLE_MEILISEARCH_EMBEDDER_MODEL?.trim() || DEFAULT_EMBEDDER_MODEL,
    // Meili's hybrid `semanticRatio` must be in [0,1]; an out-of-range value
    // 4xxs every semantic query. Clamp rather than reject so a fat-fingered
    // env var degrades gracefully instead of breaking search.
    semanticRatio: Number.isFinite(ratio)
      ? Math.min(1, Math.max(0, ratio))
      : DEFAULT_SEMANTIC_RATIO,
    fetchImpl: globalThis.fetch.bind(globalThis),
  };
}

/** Type guard for the env-driven happy path: URL is set. */
function isLive(cfg: ClientConfig): cfg is ClientConfig & { url: string } {
  return typeof cfg.url === 'string' && cfg.url.length > 0;
}

/** Joins the base url and a relative path, tolerating a trailing slash on
 * the base. Always produces exactly one separator. */
function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : '/' + path;
  return b + p;
}

interface HttpResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
  errorText: string | null;
}

/** Tiny wrapper that bundles JSON parsing + auth header so each method is
 * one line. Returns a result object rather than throwing — methods decide
 * whether to log-and-swallow or rethrow. */
async function http<T>(
  cfg: ClientConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<HttpResult<T>> {
  if (!isLive(cfg)) {
    return { ok: true, status: 200, body: null, errorText: null };
  }
  const url = joinUrl(cfg.url, path);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  let response: Response;
  try {
    response = await cfg.fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      errorText: err instanceof Error ? err.message : String(err),
    };
  }
  let parsed: unknown = null;
  const text = await response.text().catch(() => '');
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      body: null,
      errorText: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
    };
  }
  return {
    ok: true,
    status: response.status,
    body: parsed as T,
    errorText: null,
  };
}

interface MeiliSearchResponse {
  hits: Array<{ id: string; _rankingScore?: number }>;
  estimatedTotalHits: number;
}

/** Build the Meilisearch filter expression from typed inputs. Meili's
 * filter syntax is `field = "value" AND field IS NULL` — we hand-build it
 * here rather than passing user strings through, so an attacker can't
 * inject filter clauses via `folderId`. */
function buildFilter(opts: MeilisearchSearchOptions): string {
  const clauses: string[] = ['deletedAt IS NULL'];
  // `IS NULL` keeps pre-v3 documents visible until the resumable backfill
  // has populated their explicit hidden=false field.
  if (opts.includeHidden !== true) clauses.push('(hidden IS NULL OR hidden = false)');
  if (opts.folderId !== undefined && opts.folderId.length > 0) {
    // Hex chars only — defensive scrubbing in case a non-Mongo caller
    // ever passes through. ObjectId is 24 hex chars; keep liberal here.
    const safe = opts.folderId.replace(/[^a-f0-9]/gi, '');
    if (safe.length > 0) clauses.push(`folderId = "${safe}"`);
  }
  if (opts.people !== undefined && opts.people.length > 0) {
    // `people IN ["A", "B"]` — names are operator-controlled but may
    // contain quotes/backslashes; escape them so the filter expression
    // stays well-formed and can't be broken out of.
    const names = opts.people
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    if (names.length > 0) clauses.push(`people IN [${names.join(', ')}]`);
  }
  if (opts.mediaTypes !== undefined && opts.mediaTypes.length > 0) {
    const allowed = new Set<MeilisearchMediaType>(['image', 'video', 'audio']);
    const mediaTypes = [...new Set(opts.mediaTypes.filter((value) => allowed.has(value)))];
    if (mediaTypes.length > 0) {
      clauses.push(`mediaType IN [${mediaTypes.map((value) => `"${value}"`).join(', ')}]`);
    }
  }
  return clauses.join(' AND ');
}

/** Factory. Cached at module load so the boot path and the worker share
 * the same instance — but tests can call `createMeilisearchClient` directly
 * to inject a mocked `fetch`. */
export function createMeilisearchClient(override?: Partial<ClientConfig>): MeilisearchClient {
  const cfg: ClientConfig = { ...readConfig(), ...override };

  return {
    isConfigured(): boolean {
      return isLive(cfg);
    },

    semanticConfigured(): boolean {
      return isLive(cfg) && cfg.semantic;
    },

    async health(): Promise<boolean> {
      if (!isLive(cfg)) return false;
      const result = await http<{ status: string }>(cfg, 'GET', '/health');
      if (!result.ok) {
        log.warn(
          { status: result.status, err: result.errorText },
          'meilisearch health check failed',
        );
        return false;
      }
      return true;
    },

    async ensureIndex(): Promise<void> {
      if (!isLive(cfg)) return;
      // Idempotent index create. Meilisearch returns 202 with a task on
      // create, and 4xx-with-already-exists if the index is already there;
      // either path is success.
      const create = await http<unknown>(cfg, 'POST', '/indexes', {
        uid: ASSETS_INDEX,
        primaryKey: 'id',
      });
      if (
        !create.ok &&
        create.status !== 409 &&
        // Meili returns 4xx with an `index_already_exists` error code.
        !(create.errorText ?? '').includes('index_already_exists')
      ) {
        log.warn(
          {
            status: create.status,
            err: create.errorText,
            settingsVersion: REQUIRED_SETTINGS_VERSION,
          },
          'meilisearch ensureIndex create-index failed',
        );
      }
      // When semantic search is enabled, turn on the experimental
      // vector-store feature once. GA Meili builds (≥ v1.13 with vectors
      // on by default) return 404 here — swallow it; the embedders block
      // below is what actually matters.
      if (cfg.semantic) {
        const exp = await http<unknown>(cfg, 'PATCH', '/experimental-features', {
          vectorStore: true,
        });
        if (!exp.ok && exp.status !== 404) {
          log.warn(
            { status: exp.status, err: exp.errorText },
            'meilisearch ensureIndex enable-vectorStore failed',
          );
        }
      }
      // Always (re-)apply settings — these are idempotent on Meilisearch's
      // side and let us rev `REQUIRED_SETTINGS_VERSION` later when we add
      // new searchable/filterable attributes.
      const settingsBody: Record<string, unknown> = {
        // Order is the per-attribute weighting Meilisearch applies:
        // filename ranks first so exact camera identifiers stay strong,
        // then searchBlob (unified), description (higher signal than chrome),
        // people (named identities), then ocrText (often UI/menu strings).
        searchableAttributes: ['filename', 'searchBlob', 'description', 'people', 'ocrText'],
        filterableAttributes: [
          'folderId',
          'deletedAt',
          'visionSceneType',
          'visionActivity',
          'visionSubjects',
          'isScreenshot',
          'people',
          'mediaType',
          'hidden',
        ],
        sortableAttributes: ['capturedAt'],
      };
      // Register a Meili-managed Ollama embedder so Meili embeds both the
      // documents (via the template) and the query — no in-process embedding
      // on the hot search path. Only when the master switch is on.
      if (cfg.semantic) {
        settingsBody.embedders = {
          [EMBEDDER_NAME]: {
            source: 'ollama',
            url: joinUrl(cfg.embedderUrl, '/api/embeddings'),
            model: cfg.embedderModel,
            documentTemplate: '{{ doc.searchBlob }} {{ doc.description }} {{ doc.people }}',
          },
        };
      }
      const settings = await http<unknown>(
        cfg,
        'PATCH',
        `/indexes/${ASSETS_INDEX}/settings`,
        settingsBody,
      );
      if (!settings.ok) {
        log.warn(
          { status: settings.status, err: settings.errorText },
          'meilisearch ensureIndex apply-settings failed',
        );
      }
    },

    async upsert(doc: MeilisearchAssetDoc): Promise<void> {
      if (!isLive(cfg)) return;
      // Meilisearch's documents endpoint upserts on the primary key.
      const r = await http<unknown>(cfg, 'POST', `/indexes/${ASSETS_INDEX}/documents`, [doc]);
      if (!r.ok) {
        log.warn({ id: doc.id, status: r.status, err: r.errorText }, 'meilisearch upsert failed');
      }
    },

    async upsertOrThrow(doc: MeilisearchAssetDoc): Promise<void> {
      if (!isLive(cfg)) {
        throw new Error('meilisearch: not configured');
      }
      // Meilisearch's documents endpoint upserts on the primary key.
      const r = await http<unknown>(cfg, 'POST', `/indexes/${ASSETS_INDEX}/documents`, [doc]);
      if (!r.ok) {
        throw new Error(`meilisearch upsert failed: status=${r.status} ${r.errorText ?? ''}`);
      }
    },

    async upsertBatchOrThrow(docs: MeilisearchAssetDoc[]): Promise<void> {
      if (!isLive(cfg)) {
        throw new Error('meilisearch: not configured');
      }
      if (docs.length === 0) return;
      const r = await http<unknown>(cfg, 'POST', `/indexes/${ASSETS_INDEX}/documents`, docs);
      if (!r.ok) {
        throw new Error(`meilisearch batch upsert failed: status=${r.status} ${r.errorText ?? ''}`);
      }
    },

    async tombstone(id: string): Promise<void> {
      if (!isLive(cfg)) return;
      // Update the row's `deletedAt` rather than DELETE-ing the document so
      // the row stays addressable for diagnostics. The search filter
      // `deletedAt IS NULL` keeps it out of results.
      const r = await http<unknown>(cfg, 'POST', `/indexes/${ASSETS_INDEX}/documents`, [
        { id, deletedAt: new Date().toISOString() },
      ]);
      if (!r.ok) {
        log.warn({ id, status: r.status, err: r.errorText }, 'meilisearch tombstone failed');
      }
    },

    async search(q: string, opts: MeilisearchSearchOptions = {}): Promise<MeilisearchSearchResult> {
      if (!isLive(cfg)) {
        return { ids: [], estimatedTotal: 0 };
      }
      const body: Record<string, unknown> = {
        q,
        filter: buildFilter(opts),
        offset: opts.offset ?? 0,
        limit: opts.limit ?? 100,
        attributesToRetrieve: ['id'],
        showRankingScore: true,
      };
      // Hybrid (keyword + vector) only when the caller asked AND the
      // switch is on. A hybrid 4xx still throws below so the route falls
      // back to Mongo `$text`.
      if (opts.semantic && cfg.semantic) {
        body.hybrid = {
          embedder: EMBEDDER_NAME,
          semanticRatio: cfg.semanticRatio,
        };
      }
      const r = await http<MeiliSearchResponse>(
        cfg,
        'POST',
        `/indexes/${ASSETS_INDEX}/search`,
        body,
      );
      if (!r.ok || !r.body) {
        // Throw so the search route's try/catch falls back to Mongo. The
        // route logs the fallback at warn level.
        throw new Error(`meilisearch search failed: status=${r.status} ${r.errorText ?? ''}`);
      }
      const ids = r.body.hits.map((h) => h.id);
      const scores = Object.fromEntries(
        r.body.hits
          .filter((hit) => typeof hit._rankingScore === 'number')
          .map((hit) => [hit.id, hit._rankingScore!]),
      );
      return {
        ids,
        estimatedTotal: r.body.estimatedTotalHits,
        ...(Object.keys(scores).length > 0 ? { scores } : {}),
      };
    },

    async semanticStatus(): Promise<MeilisearchSemanticStatus> {
      const base = {
        configured: isLive(cfg),
        enabled: isLive(cfg) && cfg.semantic,
        embedderName: EMBEDDER_NAME,
        model: cfg.embedderModel,
        semanticRatio: cfg.semanticRatio,
      };
      if (!isLive(cfg)) {
        return {
          ...base,
          meilisearchReachable: false,
          embedderConfigured: false,
          embedderReachable: false,
          indexedDocumentCount: null,
          vectorizedDocumentCount: null,
          isIndexing: null,
          error: 'meilisearch_not_configured',
        };
      }

      const [healthResult, embeddersResult, statsResult] = await Promise.all([
        http<{ status: string }>(cfg, 'GET', '/health'),
        http<Record<string, { source?: string; model?: string }>>(
          cfg,
          'GET',
          `/indexes/${ASSETS_INDEX}/settings/embedders`,
        ),
        http<{
          numberOfDocuments: number;
          numberOfEmbeddedDocuments?: number | null;
          isIndexing: boolean;
        }>(cfg, 'GET', `/indexes/${ASSETS_INDEX}/stats`),
      ]);
      const embedder = embeddersResult.body?.[EMBEDDER_NAME];
      const embedderConfigured =
        embeddersResult.ok && embedder?.source === 'ollama' && embedder.model === cfg.embedderModel;
      let embedderReachable = false;
      let probeError: string | null = null;
      if (healthResult.ok && cfg.semantic && embedderConfigured) {
        const probe = await http<MeiliSearchResponse>(
          cfg,
          'POST',
          `/indexes/${ASSETS_INDEX}/search`,
          {
            q: 'maple semantic health probe',
            filter: 'deletedAt IS NULL AND (hidden IS NULL OR hidden = false)',
            limit: 1,
            attributesToRetrieve: ['id'],
            hybrid: { embedder: EMBEDDER_NAME, semanticRatio: cfg.semanticRatio },
          },
        );
        embedderReachable = probe.ok;
        if (!probe.ok) probeError = probe.errorText ?? `status_${probe.status}`;
      }
      const firstError =
        (!healthResult.ok && (healthResult.errorText ?? `status_${healthResult.status}`)) ||
        (!embeddersResult.ok &&
          (embeddersResult.errorText ?? `status_${embeddersResult.status}`)) ||
        (!statsResult.ok && (statsResult.errorText ?? `status_${statsResult.status}`)) ||
        probeError;
      return {
        ...base,
        meilisearchReachable: healthResult.ok,
        embedderConfigured,
        embedderReachable,
        indexedDocumentCount: statsResult.body?.numberOfDocuments ?? null,
        vectorizedDocumentCount: statsResult.body?.numberOfEmbeddedDocuments ?? null,
        isIndexing: statsResult.body?.isIndexing ?? null,
        error: firstError ? String(firstError) : null,
      };
    },
  };
}

// Module-level singleton. Tests use `createMeilisearchClient(override)` and
// `setMeilisearchClientForTests` to swap the implementation.
let singleton: MeilisearchClient | null = null;

/** Return the shared client. Reads env on first call so test bootstrap
 * (`process.env.MAPLE_MEILISEARCH_URL = ...`) takes effect. */
export function meilisearchClient(): MeilisearchClient {
  if (singleton === null) singleton = createMeilisearchClient();
  return singleton;
}

/** Replace the singleton — used by tests + by the boot path when an
 * operator changes env via the (future) settings UI. */
export function setMeilisearchClientForTests(client: MeilisearchClient | null): void {
  singleton = client;
}

/**
 * Rebuild the shared client against operator-supplied settings — called at
 * boot and on every `PUT /api/enrichment/config` so a saved Meilisearch URL
 * or API key takes effect without a restart. Both args are the already-
 * resolved values (DB > env), so passing them explicitly is authoritative:
 * `null` forces the absent state even when the corresponding env var is set
 * (an explicit `undefined` in the override beats `readConfig()`'s env read).
 */
export function reconfigureMeilisearch(url: string | null, apiKey: string | null): void {
  singleton = createMeilisearchClient({
    url: url ?? undefined,
    apiKey: apiKey ?? undefined,
  });
}
