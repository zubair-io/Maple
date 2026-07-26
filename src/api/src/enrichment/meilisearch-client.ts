/**
 * Meilisearch sidecar client — typo-tolerant text search above the Mongo
 * `$text` index. See `docs/indexer-enrichment.md` §5.5 and Phase 7 brief.
 *
 * Maple is purely a client. Operators run Meilisearch elsewhere (Proxmox VM,
 * Docker, separate host) and configure it under Settings → Workers → meili.
 *
 * Behaviour:
 *   - When no Meilisearch URL is configured, every method is a no-op
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
import {
  readMeilisearchSemanticStatus,
  type MeilisearchSemanticStatus,
} from './meilisearch-semantic-status.ts';
import {
  DEFAULT_MEILISEARCH_TASK_TIMEOUT_MS,
  isLiveConfig,
  joinMeilisearchUrl,
  meilisearchHttp,
  waitForMeilisearchTask,
  type MeilisearchTaskSummary,
  type MeilisearchTransportConfig,
} from './meilisearch-transport.ts';
import {
  DEFAULT_MEILISEARCH_EMBEDDER_URL,
  DEFAULT_MEILISEARCH_EMBEDDER_MODEL,
  DEFAULT_MEILISEARCH_SEMANTIC_ENABLED,
  DEFAULT_MEILISEARCH_SEMANTIC_RATIO,
} from './meilisearch-config.ts';

export type { MeilisearchSemanticStatus } from './meilisearch-semantic-status.ts';

const log = childLogger('enrichment:meilisearch');

/** The Meilisearch index name we manage. Single-tenant; one Maple deployment
 * gets one index regardless of how many libraries the user has registered. */
export const ASSETS_INDEX = 'assets';

/** Latest stable v1 features we rely on; bumped when we change the schema.
 * v3: adds filename/media/hidden fields and the operator-facing semantic
 * status surface. */
const REQUIRED_SETTINGS_VERSION = 3;

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

/** Safe subset of a Meilisearch search failure exposed to authenticated
 * service-search consumers. The raw response is deliberately not forwarded. */
export interface MeilisearchFailureDetails {
  status: number | null;
  code: string | null;
  type: string | null;
  message: string;
}

function failureField(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned.slice(0, maxLength) : null;
}

function failureDetails(status: number, errorText: string | null): MeilisearchFailureDetails {
  let payload: Record<string, unknown> = {};
  if (errorText) {
    try {
      const parsed = JSON.parse(errorText) as unknown;
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }
  const fallbackMessage = errorText?.replace(/\s+/g, ' ').trim().slice(0, 1000);
  return {
    status: status > 0 ? status : null,
    code: failureField(payload, 'code', 100),
    type: failureField(payload, 'type', 100),
    message:
      failureField(payload, 'message', 1000) ??
      failureField(payload, 'error', 1000) ??
      fallbackMessage ??
      'Meilisearch search request failed',
  };
}

export class MeilisearchSearchError extends Error {
  readonly details: MeilisearchFailureDetails;

  constructor(status: number, errorText: string | null) {
    const details = failureDetails(status, errorText);
    super(`meilisearch search failed: ${details.message}`);
    this.name = 'MeilisearchSearchError';
    this.details = details;
  }
}

export interface MeilisearchClient {
  /** Whether the client is configured with a sidecar URL. */
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
  /** Bulk tombstone variant used by backfill cleanup. It resolves only after
   * Meilisearch confirms the asynchronous task succeeded. */
  tombstoneBatchOrThrow?(ids: string[]): Promise<void>;
  /** Mark a document tombstoned (sets `deletedAt`). The search route filters
   * `deletedAt IS NULL` so tombstoned docs disappear from results. */
  tombstone(id: string): Promise<void>;
  /** Typo-tolerant text search. Returns ids only; the route fetches the
   * full asset rows from Mongo. Throws on transport error so the route can
   * fall back to Mongo `$text`. */
  search(q: string, opts?: MeilisearchSearchOptions): Promise<MeilisearchSearchResult>;
  /** Operator-facing semantic configuration and raw index population snapshot. */
  semanticStatus?(): Promise<MeilisearchSemanticStatus>;
}

interface ClientConfig extends MeilisearchTransportConfig {
  /** Master switch for semantic/hybrid search. Default OFF so existing
   * deployments are unaffected and Meili↔Ollama coordination is opt-in. */
  semantic: boolean;
  /** Ollama base URL Meili embeds against. */
  embedderUrl: string;
  /** Ollama embedding model id. */
  embedderModel: string;
  /** Hybrid semantic ratio (0 = pure keyword, 1 = pure vector). */
  semanticRatio: number;
}

function readConfig(): ClientConfig {
  return {
    url: process.env.MAPLE_MEILISEARCH_URL?.trim() || undefined,
    apiKey: process.env.MAPLE_MEILISEARCH_API_KEY?.trim() || undefined,
    semantic: DEFAULT_MEILISEARCH_SEMANTIC_ENABLED,
    embedderUrl: DEFAULT_MEILISEARCH_EMBEDDER_URL,
    embedderModel: DEFAULT_MEILISEARCH_EMBEDDER_MODEL,
    semanticRatio: DEFAULT_MEILISEARCH_SEMANTIC_RATIO,
    fetchImpl: globalThis.fetch.bind(globalThis),
    taskPollIntervalMs: 100,
    taskTimeoutMs: DEFAULT_MEILISEARCH_TASK_TIMEOUT_MS,
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
function folderFilter(folderId: string | undefined): string | null {
  const safe = folderId?.replace(/[^a-f0-9]/gi, '') ?? '';
  return safe.length === 0 ? null : `folderId = "${safe}"`;
}

function peopleFilter(people: string[] | undefined): string | null {
  const names = (people ?? [])
    .map((person) => person.trim())
    .filter(Boolean)
    .map((person) => `"${person.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return names.length === 0 ? null : `people IN [${names.join(', ')}]`;
}

function mediaFilter(mediaTypes: MeilisearchMediaType[] | undefined): string | null {
  const allowed = new Set<MeilisearchMediaType>(['image', 'video', 'audio']);
  const selected = [...new Set((mediaTypes ?? []).filter((value) => allowed.has(value)))];
  return selected.length === 0
    ? null
    : `mediaType IN [${selected.map((value) => `"${value}"`).join(', ')}]`;
}

function buildFilter(opts: MeilisearchSearchOptions): string {
  const clauses = [
    'deletedAt IS NULL',
    opts.includeHidden === true ? null : '(hidden IS NULL OR hidden = false)',
    folderFilter(opts.folderId),
    peopleFilter(opts.people),
    mediaFilter(opts.mediaTypes),
  ].filter((clause): clause is string => clause !== null);
  return clauses.join(' AND ');
}

async function createAssetsIndex(config: ClientConfig): Promise<void> {
  const result = await meilisearchHttp<MeilisearchTaskSummary>(config, 'POST', '/indexes', {
    uid: ASSETS_INDEX,
    primaryKey: 'id',
  });
  const alreadyExists =
    result.status === 409 || (result.errorText ?? '').includes('index_already_exists');
  if (!result.ok && !alreadyExists) {
    log.warn(
      {
        status: result.status,
        err: result.errorText,
        settingsVersion: REQUIRED_SETTINGS_VERSION,
      },
      'meilisearch ensureIndex create-index failed',
    );
    throw new Error(`meilisearch create index failed: ${result.errorText ?? result.status}`);
  }
  if (result.ok && result.status === 202) {
    await waitForMeilisearchTask(config, result, 'create assets index');
  }
}

function assetsIndexSettings(config: ClientConfig): Record<string, unknown> {
  const settings: Record<string, unknown> = {
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
  if (config.semantic) {
    settings.embedders = {
      [EMBEDDER_NAME]: {
        source: 'ollama',
        url: joinMeilisearchUrl(config.embedderUrl, '/api/embed'),
        model: config.embedderModel,
        documentTemplate: '{{ doc.searchBlob }} {{ doc.description }} {{ doc.people }}',
      },
    };
  } else {
    // An all-settings PATCH is partial: omitting embedders preserves an
    // existing configuration. Null resets it when semantic search is disabled.
    settings.embedders = null;
  }
  return settings;
}

async function applyAssetsIndexSettings(config: ClientConfig): Promise<void> {
  const result = await meilisearchHttp<MeilisearchTaskSummary>(
    config,
    'PATCH',
    `/indexes/${ASSETS_INDEX}/settings`,
    assetsIndexSettings(config),
  );
  if (!result.ok) {
    log.warn(
      { status: result.status, err: result.errorText },
      'meilisearch ensureIndex apply-settings failed',
    );
    throw new Error(`meilisearch apply settings failed: ${result.errorText ?? result.status}`);
  }
  if (result.status === 202) {
    await waitForMeilisearchTask(config, result, 'apply assets index settings');
  }
}

async function ensureAssetsIndex(config: ClientConfig): Promise<void> {
  if (!isLiveConfig(config)) return;
  await createAssetsIndex(config);
  await applyAssetsIndexSettings(config);
}

function searchRequest(
  config: ClientConfig,
  query: string,
  options: MeilisearchSearchOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    q: query,
    filter: buildFilter(options),
    offset: options.offset ?? 0,
    limit: options.limit ?? 100,
    attributesToRetrieve: ['id'],
    showRankingScore: true,
  };
  if (options.semantic && config.semantic) {
    body.hybrid = { embedder: EMBEDDER_NAME, semanticRatio: config.semanticRatio };
  }
  return body;
}

function parseSearchResult(body: MeiliSearchResponse): MeilisearchSearchResult {
  const scores = Object.fromEntries(
    body.hits
      .filter((hit) => typeof hit._rankingScore === 'number')
      .map((hit) => [hit.id, hit._rankingScore!]),
  );
  return {
    ids: body.hits.map((hit) => hit.id),
    estimatedTotal: body.estimatedTotalHits,
    ...(Object.keys(scores).length === 0 ? {} : { scores }),
  };
}

/** Factory. Cached at module load so the boot path and the worker share
 * the same instance — but tests can call `createMeilisearchClient` directly
 * to inject a mocked `fetch`. */
export function createMeilisearchClient(override?: Partial<ClientConfig>): MeilisearchClient {
  const cfg: ClientConfig = { ...readConfig(), ...override };
  let ensurePromise: Promise<void> | null = null;

  const ensureIndexOnce = (): Promise<void> => {
    if (!ensurePromise) {
      ensurePromise = ensureAssetsIndex(cfg).catch((error) => {
        ensurePromise = null;
        throw error;
      });
    }
    return ensurePromise;
  };

  return {
    isConfigured(): boolean {
      return isLiveConfig(cfg);
    },

    semanticConfigured(): boolean {
      return isLiveConfig(cfg) && cfg.semantic;
    },

    async health(): Promise<boolean> {
      if (!isLiveConfig(cfg)) return false;
      const result = await meilisearchHttp<{ status: string }>(cfg, 'GET', '/health');
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
      await ensureIndexOnce();
    },

    async upsert(doc: MeilisearchAssetDoc): Promise<void> {
      if (!isLiveConfig(cfg)) return;
      // Meilisearch's documents endpoint upserts on the primary key.
      const r = await meilisearchHttp<unknown>(cfg, 'POST', `/indexes/${ASSETS_INDEX}/documents`, [
        doc,
      ]);
      if (!r.ok) {
        log.warn({ id: doc.id, status: r.status, err: r.errorText }, 'meilisearch upsert failed');
      }
    },

    async upsertOrThrow(doc: MeilisearchAssetDoc): Promise<void> {
      if (!isLiveConfig(cfg)) {
        throw new Error('meilisearch: not configured');
      }
      // Meilisearch's documents endpoint upserts on the primary key.
      const r = await meilisearchHttp<unknown>(cfg, 'POST', `/indexes/${ASSETS_INDEX}/documents`, [
        doc,
      ]);
      if (!r.ok) {
        throw new Error(`meilisearch upsert failed: status=${r.status} ${r.errorText ?? ''}`);
      }
    },

    async upsertBatchOrThrow(docs: MeilisearchAssetDoc[]): Promise<void> {
      if (!isLiveConfig(cfg)) {
        throw new Error('meilisearch: not configured');
      }
      if (docs.length === 0) return;
      const accepted = await meilisearchHttp<MeilisearchTaskSummary>(
        cfg,
        'POST',
        `/indexes/${ASSETS_INDEX}/documents`,
        docs,
      );
      await waitForMeilisearchTask(cfg, accepted, 'batch upsert');
    },

    async tombstoneBatchOrThrow(ids: string[]): Promise<void> {
      if (!isLiveConfig(cfg)) throw new Error('meilisearch: not configured');
      if (ids.length === 0) return;
      const deletedAt = new Date().toISOString();
      const accepted = await meilisearchHttp<MeilisearchTaskSummary>(
        cfg,
        'POST',
        `/indexes/${ASSETS_INDEX}/documents`,
        ids.map((id) => ({ id, deletedAt })),
      );
      await waitForMeilisearchTask(cfg, accepted, 'batch tombstone');
    },

    async tombstone(id: string): Promise<void> {
      if (!isLiveConfig(cfg)) return;
      // Update the row's `deletedAt` rather than DELETE-ing the document so
      // the row stays addressable for diagnostics. The search filter
      // `deletedAt IS NULL` keeps it out of results.
      const r = await meilisearchHttp<unknown>(cfg, 'POST', `/indexes/${ASSETS_INDEX}/documents`, [
        { id, deletedAt: new Date().toISOString() },
      ]);
      if (!r.ok) {
        log.warn({ id, status: r.status, err: r.errorText }, 'meilisearch tombstone failed');
      }
    },

    async search(q: string, opts: MeilisearchSearchOptions = {}): Promise<MeilisearchSearchResult> {
      if (!isLiveConfig(cfg)) {
        return { ids: [], estimatedTotal: 0 };
      }
      const r = await meilisearchHttp<MeiliSearchResponse>(
        cfg,
        'POST',
        `/indexes/${ASSETS_INDEX}/search`,
        searchRequest(cfg, q, opts),
      );
      if (!r.ok || !r.body) {
        // Throw so the search route's try/catch falls back to Mongo. The
        // route logs the fallback at warn level.
        throw new MeilisearchSearchError(r.status, r.errorText);
      }
      return parseSearchResult(r.body);
    },

    async semanticStatus(): Promise<MeilisearchSemanticStatus> {
      return readMeilisearchSemanticStatus(cfg, ASSETS_INDEX, EMBEDDER_NAME);
    },
  };
}

// Module-level singleton. Tests use `createMeilisearchClient(override)` and
// `setMeilisearchClientForTests` to swap the implementation.
let singleton: MeilisearchClient | null = null;

/** Return the process-cached client. This path performs no DB I/O; settings
 * are resolved only at startup/save and installed through reconfigure below. */
export function meilisearchClient(): MeilisearchClient {
  if (singleton === null) singleton = createMeilisearchClient();
  return singleton;
}

/** Replace the singleton for isolated tests. */
export function setMeilisearchClientForTests(client: MeilisearchClient | null): void {
  singleton = client;
}

/**
 * Rebuild the shared client against operator-supplied settings — called at
 * boot and on every `PUT /api/enrichment/config` so a saved Meilisearch URL
 * or semantic setting takes effect without a restart. Arguments are already
 * resolved values, so passing them explicitly is authoritative: `null` forces
 * the absent state even when a bootstrap URL environment variable is set.
 */
export interface MeilisearchRuntimeSettings {
  url: string | null;
  apiKey: string | null;
  taskTimeoutMs: number;
  semanticEnabled: boolean;
  embedderUrl: string;
  embedderModel: string;
  semanticRatio: number;
}

export function reconfigureMeilisearch(settings: MeilisearchRuntimeSettings): void {
  singleton = createMeilisearchClient({
    url: settings.url ?? undefined,
    apiKey: settings.apiKey ?? undefined,
    taskTimeoutMs: settings.taskTimeoutMs,
    semantic: settings.semanticEnabled,
    embedderUrl: settings.embedderUrl,
    embedderModel: settings.embedderModel,
    semanticRatio: settings.semanticRatio,
  });
}
