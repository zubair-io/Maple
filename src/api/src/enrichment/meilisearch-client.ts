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

import { child as childLogger } from "../log.ts";

const log = childLogger("enrichment:meilisearch");

/** The Meilisearch index name we manage. Single-tenant; one Maple deployment
 * gets one index regardless of how many libraries the user has registered. */
export const ASSETS_INDEX = "assets";

/** Latest stable v1 features we rely on; bumped when we change the schema. */
const REQUIRED_SETTINGS_VERSION = 1;

/** Document shape we push to Meilisearch. Mirror of the unified
 * `asset.search_blob` field plus the per-attribute sources so
 * Meilisearch can apply per-field weighting (POI/place metadata typically
 * outranks description prose, which outranks OCR'd UI chrome). */
export interface MeilisearchAssetDoc {
  /** Unique document id. We use the asset's stable `maple_id` so re-upserts
   * are idempotent even after rename/move (the absPath changes; mapleId
   * doesn't). */
  id: string;
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
}

export interface MeilisearchSearchOptions {
  /** Hex folder id; passed through to Meilisearch's filter syntax. */
  folderId?: string;
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
}

export interface MeilisearchClient {
  /** Whether the client is configured (URL set in env). */
  isConfigured(): boolean;
  /** Reachability check used at boot. Returns false on any error
   * (unconfigured, unreachable, 4xx, etc.) so the caller can warn-and-continue. */
  health(): Promise<boolean>;
  /** Idempotent index + settings creation. Safe to call on every boot. */
  ensureIndex(): Promise<void>;
  /** Fire-and-forget upsert. Errors are logged and swallowed. */
  upsert(doc: MeilisearchAssetDoc): Promise<void>;
  /** Mark a document tombstoned (sets `deletedAt`). The search route filters
   * `deletedAt IS NULL` so tombstoned docs disappear from results. */
  tombstone(id: string): Promise<void>;
  /** Typo-tolerant text search. Returns ids only; the route fetches the
   * full asset rows from Mongo. Throws on transport error so the route can
   * fall back to Mongo `$text`. */
  search(q: string, opts?: MeilisearchSearchOptions): Promise<MeilisearchSearchResult>;
}

interface ClientConfig {
  url: string | undefined;
  apiKey: string | undefined;
  fetchImpl: typeof fetch;
}

function readConfig(): ClientConfig {
  return {
    url: process.env.MAPLE_MEILISEARCH_URL?.trim() || undefined,
    apiKey: process.env.MAPLE_MEILISEARCH_API_KEY?.trim() || undefined,
    fetchImpl: globalThis.fetch.bind(globalThis),
  };
}

/** Type guard for the env-driven happy path: URL is set. */
function isLive(cfg: ClientConfig): cfg is ClientConfig & { url: string } {
  return typeof cfg.url === "string" && cfg.url.length > 0;
}

/** Joins the base url and a relative path, tolerating a trailing slash on
 * the base. Always produces exactly one separator. */
function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : "/" + path;
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
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<HttpResult<T>> {
  if (!isLive(cfg)) {
    return { ok: true, status: 200, body: null, errorText: null };
  }
  const url = joinUrl(cfg.url, path);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
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
  const text = await response.text().catch(() => "");
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
      errorText: typeof parsed === "string" ? parsed : JSON.stringify(parsed),
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
  hits: Array<{ id: string }>;
  estimatedTotalHits: number;
}

/** Build the Meilisearch filter expression from typed inputs. Meili's
 * filter syntax is `field = "value" AND field IS NULL` — we hand-build it
 * here rather than passing user strings through, so an attacker can't
 * inject filter clauses via `folderId`. */
function buildFilter(opts: MeilisearchSearchOptions): string {
  const clauses: string[] = ["deletedAt IS NULL"];
  if (opts.folderId !== undefined && opts.folderId.length > 0) {
    // Hex chars only — defensive scrubbing in case a non-Mongo caller
    // ever passes through. ObjectId is 24 hex chars; keep liberal here.
    const safe = opts.folderId.replace(/[^a-f0-9]/gi, "");
    if (safe.length > 0) clauses.push(`folderId = "${safe}"`);
  }
  return clauses.join(" AND ");
}

/** Factory. Cached at module load so the boot path and the worker share
 * the same instance — but tests can call `createMeilisearchClient` directly
 * to inject a mocked `fetch`. */
export function createMeilisearchClient(
  override?: Partial<ClientConfig>,
): MeilisearchClient {
  const cfg: ClientConfig = { ...readConfig(), ...override };

  return {
    isConfigured(): boolean {
      return isLive(cfg);
    },

    async health(): Promise<boolean> {
      if (!isLive(cfg)) return false;
      const result = await http<{ status: string }>(cfg, "GET", "/health");
      if (!result.ok) {
        log.warn(
          { status: result.status, err: result.errorText },
          "meilisearch health check failed",
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
      const create = await http<unknown>(cfg, "POST", "/indexes", {
        uid: ASSETS_INDEX,
        primaryKey: "id",
      });
      if (
        !create.ok &&
        create.status !== 409 &&
        // Meili returns 4xx with an `index_already_exists` error code.
        !(create.errorText ?? "").includes("index_already_exists")
      ) {
        log.warn(
          {
            status: create.status,
            err: create.errorText,
            settingsVersion: REQUIRED_SETTINGS_VERSION,
          },
          "meilisearch ensureIndex create-index failed",
        );
      }
      // Always (re-)apply settings — these are idempotent on Meilisearch's
      // side and let us rev `REQUIRED_SETTINGS_VERSION` later when we add
      // new searchable/filterable attributes.
      const settings = await http<unknown>(
        cfg,
        "PATCH",
        `/indexes/${ASSETS_INDEX}/settings`,
        {
          // Order is the per-attribute weighting Meilisearch applies:
          // searchBlob (unified, includes everything) ranks first, then
          // description (LLM caption — higher signal than chrome), then
          // ocrText (often UI/menu strings).
          searchableAttributes: ["searchBlob", "description", "ocrText"],
          filterableAttributes: ["folderId", "deletedAt"],
          sortableAttributes: ["capturedAt"],
        },
      );
      if (!settings.ok) {
        log.warn(
          { status: settings.status, err: settings.errorText },
          "meilisearch ensureIndex apply-settings failed",
        );
      }
    },

    async upsert(doc: MeilisearchAssetDoc): Promise<void> {
      if (!isLive(cfg)) return;
      // Meilisearch's documents endpoint upserts on the primary key.
      const r = await http<unknown>(
        cfg,
        "POST",
        `/indexes/${ASSETS_INDEX}/documents`,
        [doc],
      );
      if (!r.ok) {
        log.warn(
          { id: doc.id, status: r.status, err: r.errorText },
          "meilisearch upsert failed",
        );
      }
    },

    async tombstone(id: string): Promise<void> {
      if (!isLive(cfg)) return;
      // Update the row's `deletedAt` rather than DELETE-ing the document so
      // the row stays addressable for diagnostics. The search filter
      // `deletedAt IS NULL` keeps it out of results.
      const r = await http<unknown>(
        cfg,
        "POST",
        `/indexes/${ASSETS_INDEX}/documents`,
        [{ id, deletedAt: new Date().toISOString() }],
      );
      if (!r.ok) {
        log.warn(
          { id, status: r.status, err: r.errorText },
          "meilisearch tombstone failed",
        );
      }
    },

    async search(
      q: string,
      opts: MeilisearchSearchOptions = {},
    ): Promise<MeilisearchSearchResult> {
      if (!isLive(cfg)) {
        return { ids: [], estimatedTotal: 0 };
      }
      const r = await http<MeiliSearchResponse>(
        cfg,
        "POST",
        `/indexes/${ASSETS_INDEX}/search`,
        {
          q,
          filter: buildFilter(opts),
          offset: opts.offset ?? 0,
          limit: opts.limit ?? 100,
          attributesToRetrieve: ["id"],
        },
      );
      if (!r.ok || !r.body) {
        // Throw so the search route's try/catch falls back to Mongo. The
        // route logs the fallback at warn level.
        throw new Error(
          `meilisearch search failed: status=${r.status} ${r.errorText ?? ""}`,
        );
      }
      const ids = r.body.hits.map((h) => h.id);
      return { ids, estimatedTotal: r.body.estimatedTotalHits };
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
export function setMeilisearchClientForTests(
  client: MeilisearchClient | null,
): void {
  singleton = client;
}
