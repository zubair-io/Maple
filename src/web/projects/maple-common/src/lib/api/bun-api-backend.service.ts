// BunApiBackend — HttpClient wrapper for the Maple Self Hosted API.
//
// Endpoints documented in src/api/README.md.
// All methods return Observable<T> per best-practices (no firstValueFrom).
//
// Base URL comes from API_BASE_URL (default '/api'), so deployments behind a
// reverse proxy work without rebuilding the bundle.

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';

export interface ApiFolder {
  id: string;
  path: string;
  /** Display label — defaults to the basename of `path` on the server side. */
  label: string;
  /** Last full-scan timestamp (ISO 8601), or null if the library has never been scanned. */
  last_scan: string | null;
  /** Cached count of files indexed under this library. */
  file_count: number;
  /** When the library was registered (ISO 8601). */
  created_at: string;
}

export interface ApiAsset {
  id: string;
  filename: string;
  folderId: string;
  width?: number;
  height?: number;
  rating: number;
  flag: 'unflagged' | 'pick' | 'reject';
  colorLabel: string | null;
}

export interface ApiAssetPage {
  assets: ApiAsset[];
  total: number;
  page: number;
  limit: number;
}

// ─── Enrichment / detail-pane shapes ────────────────────────────────────────
// Mirror the Mongo schema (`src/api/src/db/schema.ts`). Snake_case fields
// because the API ships the documents as-is for fidelity.

export interface ApiPlaceAddress {
  house_number?: string;
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  state?: string;
  state_code?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
}

export interface ApiPlacePoi {
  name: string;
  category: string;
  type: string;
}

export interface ApiPlaceRollups {
  locality: string | null;
  region: string | null;
  country_code: string | null;
}

export interface ApiPlace {
  source: string;
  geocoder_version: number;
  geocoded_at: string;
  lat: number;
  lon: number;
  display_name: string | null;
  address: ApiPlaceAddress;
  pois: ApiPlacePoi[];
  rollups: ApiPlaceRollups;
  search_blob: string;
}

export interface ApiAssetFace {
  bbox: { x: number; y: number; w: number; h: number };
  person_id: string | null;
  confidence: number;
}

export interface ApiEnrichmentStageState {
  done_at: string | null;
  locked_by: string | null;
  lease_expires_at: string | null;
  attempts: number;
  last_error: string | null;
  version: number | null;
  dead_letter_at: string | null;
}

export type ApiEnrichmentStage = 'geocode' | 'face' | 'describe' | 'ocr';

export interface ApiEnrichment {
  geocode: ApiEnrichmentStageState;
  face: ApiEnrichmentStageState;
  describe: ApiEnrichmentStageState;
  ocr: ApiEnrichmentStageState;
}

export interface ApiOcrMeta {
  engine: string;
  engine_version: string;
  generated_at: string;
}

export interface ApiDescriptionMeta {
  provider?: string;
  model?: string;
  cost_usd?: number;
  generated_at?: string;
  prompt_version?: number;
  [key: string]: unknown;
}

export interface ApiAssetDetail {
  id: string;
  folder_id: string;
  filename: string;
  abs_path: string;
  size: number;
  mtime: number;
  rating: number;
  flag: -1 | 0 | 1;
  color_label: string;
  indexed_at: string;
  place: ApiPlace | null;
  faces: ApiAssetFace[];
  description: string | null;
  description_meta: ApiDescriptionMeta | null;
  ocr_text: string | null;
  ocr_meta: ApiOcrMeta | null;
  enrichment: ApiEnrichment;
}

export interface ApiRequeueResponse {
  stage: ApiEnrichmentStage;
  version: number;
}

export interface ApiDirEntry {
  name: string;
  path: string;
  hasChildren: boolean;
}

export interface ApiDirListing {
  path: string;
  parent: string | null;
  entries: ApiDirEntry[];
}

export type IndexerStage = 'discover' | 'hash' | 'exif' | 'thumb' | 'ai' | 'mongo';

export interface IndexerStageCounters {
  inFlight: number;
  errors: number;
  deadLetter: number;
}

export interface IndexerChannelInfo {
  depth: number;
  capacity: number;
}

export interface IndexerStatus {
  paused: boolean;
  pools: Record<IndexerStage, number>;
  channels: Record<IndexerStage, IndexerChannelInfo>;
  stages: Record<IndexerStage, IndexerStageCounters>;
  /** Files currently being processed per stage (capped). Empty when idle. */
  inFlightPaths?: Record<IndexerStage, string[]>;
  /** Cumulative count of jobs completed (success+fail) per stage since the
   * server started. Resets on process restart — not persisted. */
  processed?: Record<IndexerStage, number>;
  /** Number of folders currently being watched. */
  folders?: number;
  /** Whether the indexer service has started. */
  started?: boolean;
  /** EXIF backfill (one-shot upgrade for pre-EXIF rows). */
  exifBackfill?: IndexerExifBackfillStatus;
}

export interface IndexerExifBackfillStatus {
  /** True while a backfill run is in flight. */
  running: boolean;
  /** Rows processed so far in the current/last run. */
  scanned: number;
  /** Rows successfully upgraded so far in the current/last run. */
  upgraded: number;
  /** Estimated rows still missing exif at the start of the run. -1 = unknown. */
  pending: number;
  /** ISO timestamp the most recent run finished, or null if never run. */
  lastFinishedAt: string | null;
  /** Error from the most recent run, or null if it succeeded. */
  lastError: string | null;
}

export interface IndexerDeadLetterItem {
  id?: string;
  stage: string;
  jobId?: string;
  absPath?: string;
  error?: string;
  attempts?: number;
  failedAt?: string;
  /** Mongo dedupe key — mapleId hex if known, otherwise absPath. Required
   * for row-scoped reset; older payloads may omit this field. */
  key?: string;
}

export interface IndexerDeadLetterPage {
  items: IndexerDeadLetterItem[];
  total: number;
  warning?: string;
}

/** One cluster row from `GET /api/indexer/dead-letter/groups`. Bucketed by
 * (stage, errorClass) where errorClass is a normalised prefix of `error`. */
export interface IndexerDeadLetterGroup {
  stage: IndexerStage;
  errorClass: string;
  count: number;
  /** ISO timestamp of the most recent failure in the group. */
  latestTs: string;
}

export interface IndexerDeadLetterGroupsResponse {
  groups: IndexerDeadLetterGroup[];
}

export interface IndexerDeadLetterFilter {
  stage?: IndexerStage;
  errorPrefix?: string;
  limit?: number;
}

export interface IndexerDeadLetterResetRequest {
  /** Per-row reset (Mongo dedupe key — mapleId hex or abs_path). */
  key?: string;
  /** Stage-wide reset. Without `key`, deletes every row matching the stage. */
  stage?: IndexerStage;
}

export interface IndexerDeadLetterResetResponse {
  deletedCount: number;
}

/**
 * Supervisor view of the standalone indexer child process. Mirrors
 * `IndexerProcessState` from `src/api/src/indexer/control.ts`.
 */
export interface IndexerProcessState {
  status: 'stopped' | 'starting' | 'running' | 'crashed' | 'restarting';
  pid: number | null;
  lastStartedAt: string | null;
  lastExitCode: number | null;
  lastError: string | null;
  restartCount: number;
}

export interface IndexerLifecycleResponse {
  ok: boolean;
  state: IndexerProcessState;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class BunApiBackendService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  listFolders(): Observable<ApiFolder[]> {
    return this.http.get<ApiFolder[]>(`${this.base}/folders`);
  }

  registerFolder(folderPath: string): Observable<ApiFolder> {
    return this.http.post<ApiFolder>(`${this.base}/folders`, { path: folderPath });
  }

  listDir(absPath: string, showAll = false): Observable<ApiDirListing> {
    let params = new HttpParams().set('path', absPath);
    if (showAll) params = params.set('showAll', '1');
    return this.http.get<ApiDirListing>(`${this.base}/fs/list`, { params });
  }

  listAssets(folderId: string, page = 1, limit = 100): Observable<ApiAssetPage> {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    return this.http.get<ApiAssetPage>(
      `${this.base}/folders/${folderId}/assets?${params.toString()}`,
    );
  }

  getAsset(assetId: string): Observable<ApiAsset> {
    return this.http.get<ApiAsset>(`${this.base}/assets/${assetId}`);
  }

  /** Detail-pane payload — same `/api/assets/:id` route, but typed to surface
   * the enrichment outputs (place, faces, description, ocr) the info-pane
   * needs. Snake_case fields pass through untouched. */
  getAssetDetails(assetId: string): Observable<ApiAssetDetail> {
    return this.http.get<ApiAssetDetail>(`${this.base}/assets/${assetId}`);
  }

  /** Manually override the reverse-geocoded place. `null` clears the
   * override; the next worker run will repopulate. Server recomputes
   * `search_blob` atomically using the same expression the geocode worker
   * uses. */
  setAssetPlaceOverride(
    assetId: string,
    place: ApiPlace | null,
  ): Observable<void> {
    return this.http.put<void>(`${this.base}/assets/${assetId}/place`, { place });
  }

  /** Manually override the LLM caption. Pass `null` to clear. */
  setAssetDescriptionOverride(
    assetId: string,
    text: string | null,
  ): Observable<void> {
    return this.http.put<void>(`${this.base}/assets/${assetId}/description`, { text });
  }

  /** Manually override the OCR text. Pass `null` to clear. */
  setAssetOcrOverride(
    assetId: string,
    text: string | null,
  ): Observable<void> {
    return this.http.put<void>(`${this.base}/assets/${assetId}/ocr`, { text });
  }

  /** Reset a per-stage enrichment state so the worker re-runs on its next
   * tick: `done_at` cleared, `version` bumped by 1, attempt counter +
   * dead-letter timestamp wiped, lock released. */
  requeueEnrichmentStage(
    assetId: string,
    stage: ApiEnrichmentStage,
  ): Observable<ApiRequeueResponse> {
    return this.http.post<ApiRequeueResponse>(
      `${this.base}/assets/${assetId}/enrichment/requeue`,
      { stage },
    );
  }

  getRawBytes(assetId: string): Observable<ArrayBuffer> {
    return this.http.get(`${this.base}/assets/${assetId}/raw`, {
      responseType: 'arraybuffer',
    });
  }

  getThumb(assetId: string, size = '320x320'): Observable<Blob> {
    return this.http.get(`${this.base}/assets/${assetId}/thumb?size=${size}`, {
      responseType: 'blob',
    });
  }

  getXmp(assetId: string): Observable<string> {
    return this.http.get(`${this.base}/assets/${assetId}/xmp`, { responseType: 'text' });
  }

  putXmp(assetId: string, xml: string): Observable<void> {
    return this.http.put<void>(`${this.base}/assets/${assetId}/xmp`, xml, {
      headers: { 'Content-Type': 'application/xml' },
    });
  }

  getIndexerStatus(): Observable<IndexerStatus> {
    return this.http.get<IndexerStatus>(`${this.base}/indexer/status`);
  }

  setIndexerWorkers(workers: Partial<Record<IndexerStage, number>>): Observable<{ ok: boolean; status: IndexerStatus }> {
    return this.http.put<{ ok: boolean; status: IndexerStatus }>(
      `${this.base}/indexer/config`,
      { workers },
    );
  }

  pauseIndexer(): Observable<{ ok: boolean; status: IndexerStatus }> {
    return this.http.post<{ ok: boolean; status: IndexerStatus }>(`${this.base}/indexer/pause`, {});
  }

  resumeIndexer(): Observable<{ ok: boolean; status: IndexerStatus }> {
    return this.http.post<{ ok: boolean; status: IndexerStatus }>(`${this.base}/indexer/resume`, {});
  }

  /** Force a re-scan of one library folder. Server walks the folder
   * tree (or just `subPath` if supplied — must resolve under the
   * library root) and pushes every supported file into the discover
   * channel with priority — every stage forwards via pushFront so the
   * jobs hop the existing backlog. The fast-tier upsert is idempotent;
   * unchanged files no-op, new ones get indexed.
   *
   * Returns immediately; the walk runs in the background. Useful when
   * the operator just dropped a memory card and wants those photos
   * surfaced ahead of an in-progress initial walk. */
  rescanFolder(
    folderId: string,
    opts: { subPath?: string } = {},
  ): Observable<{ ok: boolean; folderId: string; path: string; error?: string }> {
    return this.http.post<{ ok: boolean; folderId: string; path: string; error?: string }>(
      `${this.base}/indexer/rescan/${encodeURIComponent(folderId)}`,
      opts.subPath ? { subPath: opts.subPath } : {},
    );
  }

  listDeadLetter(limit = 200): Observable<IndexerDeadLetterPage> {
    const params = new HttpParams().set('limit', String(limit));
    return this.http.get<IndexerDeadLetterPage>(`${this.base}/indexer/dead-letter`, { params });
  }

  /** Filtered dead-letter list — server-side narrowing by stage and/or error
   * prefix. Mirrors `listDeadLetter`'s response shape so the UI can swap one
   * for the other without changing rendering code. */
  filterDeadLetter(filter: IndexerDeadLetterFilter): Observable<IndexerDeadLetterPage> {
    let params = new HttpParams();
    if (filter.stage) params = params.set('stage', filter.stage);
    if (filter.errorPrefix) params = params.set('errorPrefix', filter.errorPrefix);
    params = params.set('limit', String(filter.limit ?? 200));
    return this.http.get<IndexerDeadLetterPage>(`${this.base}/indexer/dead-letter`, { params });
  }

  /** Cluster the dead-letter collection by (stage, errorClass). Used by the
   * triage card's group view so an operator can see which failure modes
   * dominate before drilling into a single row. */
  groupDeadLetter(): Observable<IndexerDeadLetterGroupsResponse> {
    return this.http.get<IndexerDeadLetterGroupsResponse>(
      `${this.base}/indexer/dead-letter/groups`,
    );
  }

  /** Delete dead-letter rows matching the request body so the watcher can
   * re-attempt. `{ key }` is per-row; `{ stage }` wipes everything for the
   * stage; `{ key, stage }` ANDs the two. */
  resetDeadLetter(
    request: IndexerDeadLetterResetRequest,
  ): Observable<IndexerDeadLetterResetResponse> {
    return this.http.post<IndexerDeadLetterResetResponse>(
      `${this.base}/indexer/dead-letter/reset`,
      request,
    );
  }

  /** Read the supervisor's view of the indexer child process. */
  getIndexerProcess(): Observable<IndexerProcessState> {
    return this.http.get<IndexerProcessState>(`${this.base}/indexer/process`);
  }

  /** Spawn (or re-spawn) the standalone indexer child and wait for it to
   * report ready. Returns the supervisor state on completion. */
  startIndexer(): Observable<IndexerLifecycleResponse> {
    return this.http.post<IndexerLifecycleResponse>(`${this.base}/indexer/start`, {});
  }

  /** SIGTERM the indexer child (forced kill on grace timeout). */
  stopIndexer(): Observable<IndexerLifecycleResponse> {
    return this.http.post<IndexerLifecycleResponse>(`${this.base}/indexer/stop`, {});
  }

  // -------------------------------------------------------------------------
  // Slow-tier enrichment (Phase 2+ workers — geocode, face, describe).
  // The `source` field on the GET response says whether each value came from
  // the DB row (operator saved it via the UI), an env var (deployment-time
  // fallback), or a built-in default.
  // -------------------------------------------------------------------------

  getEnrichmentConfig(): Observable<EnrichmentConfigResponse> {
    return this.http.get<EnrichmentConfigResponse>(`${this.base}/enrichment/config`);
  }

  /** Save and immediately re-apply. Server runs a Nominatim health-check
   * before persisting when `geocode_worker_enabled` is true and a URL is
   * supplied — a 502 means the URL is wrong and nothing was saved.
   *
   * `nominatim_rate_limit_per_sec` is optional: omit it to leave the
   * existing value alone, send a number to set, or send `null` to clear
   * back to the env-or-default fallback. */
  saveEnrichmentConfig(
    body: {
      nominatim_url: string | null;
      geocode_worker_enabled: boolean;
      nominatim_rate_limit_per_sec?: number | null;
      // ── Describe worker (Phase 6) ────────────────────────────────
      describe_worker_enabled?: boolean | null;
      describe_provider?: DescribeProviderName | null;
      describe_model?: string | null;
      describe_system_prompt?: string | null;
      describe_daily_cap_usd?: number | null;
      describe_provider_url?: string | null;
      // ── Face worker (Phase 5) ─────────────────────────────────────
      face_worker_enabled?: boolean | null;
      // ── Face model paths (Phase 5) ────────────────────────────────
      /** `null` clears the override back to env / built-in default. */
      face_model_dir?: string | null;
      face_retinaface_url?: string | null;
      face_retinaface_sha256?: string | null;
      face_mobilefacenet_url?: string | null;
      face_mobilefacenet_sha256?: string | null;
      // ── OCR worker (Phase 8) ──────────────────────────────────────
      ocr_worker_enabled?: boolean | null;
    },
  ): Observable<EnrichmentConfigResponse> {
    return this.http.put<EnrichmentConfigResponse>(`${this.base}/enrichment/config`, body);
  }

  /** Health-check an arbitrary Nominatim URL without saving. Used for the
   * "Test connection" button in the settings UI. */
  testNominatim(url: string): Observable<EnrichmentTestResponse> {
    return this.http.post<EnrichmentTestResponse>(`${this.base}/enrichment/test`, {
      nominatim_url: url,
    });
  }

  /** Health-check a describe provider without saving. The `api_key` field
   * is write-only — pass it for paid providers when the user is testing
   * a freshly-typed key; the server never echoes it back. */
  testDescribeProvider(
    body: {
      provider: DescribeProviderName;
      url?: string | null;
      model?: string | null;
      api_key?: string | null;
    },
  ): Observable<EnrichmentTestDescribeResponse> {
    return this.http.post<EnrichmentTestDescribeResponse>(
      `${this.base}/enrichment/test-describe`,
      body,
    );
  }

  // -------------------------------------------------------------------------
  // People — face-cluster identities. The `/people` UI consumes these.
  // -------------------------------------------------------------------------

  listPeople(): Observable<ApiPerson[]> {
    return this.http.get<ApiPersonRaw[]>(`${this.base}/people`).pipe(
      // Normalise snake_case → camelCase for the UI layer. Done here so
      // every component that consumes the service gets the same shape.
      map((rows) =>
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          faceCount: r.face_count,
          coverFaceId: r.cover_face_id ?? null,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      ),
    );
  }

  getPerson(id: string): Observable<ApiPersonDetail> {
    return this.http.get<ApiPersonDetailRaw>(`${this.base}/people/${id}`).pipe(
      map((r) => ({
        id: r.id,
        name: r.name,
        coverFaceId: r.cover_face_id ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        faces: r.faces.map((f) => ({
          assetId: f.asset_id,
          faceIndex: f.face_index,
          absPath: f.abs_path,
          bbox: f.bbox,
          confidence: f.confidence,
        })),
      })),
    );
  }

  createPerson(body: { name: string }): Observable<ApiPersonSummary> {
    return this.http
      .post<ApiPersonSummaryRaw>(`${this.base}/people`, body)
      .pipe(map((r) => ({ id: r.id, name: r.name })));
  }

  /** Returns the survivor + the orphan id when a merge happened. */
  renamePerson(id: string, name: string): Observable<ApiRenameResult> {
    return this.http
      .put<ApiRenameResultRaw>(`${this.base}/people/${id}`, { name })
      .pipe(
        map((r) => ({
          id: r.id,
          name: r.name,
          mergedFrom: r.merged_from ?? null,
        })),
      );
  }

  assignFaceToPerson(
    assetId: string,
    faceIndex: number,
    personId: string | null,
  ): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`${this.base}/people/assign`, {
      asset_id: assetId,
      face_index: faceIndex,
      person_id: personId,
    });
  }

  /** Synchronous online clustering. Returns counts. */
  runClustering(): Observable<ApiClusterResult> {
    return this.http
      .post<ApiClusterResultRaw>(`${this.base}/people/cluster`, {})
      .pipe(
        map((r) => ({
          assigned: r.assigned,
          newPeople: r.new_people,
          scanned: r.scanned,
        })),
      );
  }

  deletePerson(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/people/${id}`);
  }
}

export type DescribeProviderName = 'ollama' | 'anthropic' | 'openai' | 'gemini';

export interface EnrichmentConfigResponse {
  nominatim_url: string | null;
  geocode_worker_enabled: boolean;
  /** Sustained Nominatim throttle (token-bucket refill rate). Always a
   * number on the wire — the server resolves DB/env/default before
   * responding. */
  nominatim_rate_limit_per_sec: number;
  // ── Describe worker (Phase 6) ──────────────────────────────────────
  describe_worker_enabled: boolean;
  describe_provider: DescribeProviderName;
  /** `null` for paid providers (their endpoints are hard-coded). */
  describe_provider_url: string | null;
  describe_model: string;
  describe_system_prompt: string;
  describe_daily_cap_usd: number;
  /** Phase 5 face worker. Default false until the operator opts in. */
  face_worker_enabled: boolean;
  /** Resolved model dir (DB → env → ~/.maple/models/). Always populated. */
  face_model_dir: string;
  /** `null` when neither DB nor env supplied a download URL — the worker
   * then requires the file to be already on disk under face_model_dir. */
  face_retinaface_url: string | null;
  face_retinaface_sha256: string | null;
  face_mobilefacenet_url: string | null;
  face_mobilefacenet_sha256: string | null;
  /** Phase 8 OCR worker. Default false until the operator opts in. */
  ocr_worker_enabled: boolean;
  /** Set when face worker is enabled but the model files are missing — UI
   * surfaces this as an actionable banner. Optional for backward compat. */
  face_worker_dormant_reason?: string | null;
  /** Live face-model loader status + on-disk probe. The UI uses this to
   * render the badge on the face card: green "loaded · sizes",
   * blue "downloading…", red "error: <detail>", or neutral "files
   * present" / "missing — auto-download will run". */
  face_models?: {
    status: 'idle' | 'downloading' | 'loaded' | 'error';
    error_detail: string | null;
    retinaface: { path: string; present: boolean; bytes: number };
    mobilefacenet: { path: string; present: boolean; bytes: number };
  };
  source: {
    nominatim_url: 'db' | 'env' | 'unset';
    geocode_worker_enabled: 'db' | 'env' | 'default';
    nominatim_rate_limit_per_sec: 'db' | 'env' | 'default';
    describe_worker_enabled: 'db' | 'env' | 'default';
    describe_provider: 'db' | 'env' | 'default';
    describe_provider_url: 'db' | 'env' | 'default' | 'unset';
    describe_model: 'db' | 'env' | 'default';
    describe_system_prompt: 'db' | 'env' | 'default';
    describe_daily_cap_usd: 'db' | 'env' | 'default';
    face_worker_enabled: 'db' | 'env' | 'default';
    face_model_dir: 'db' | 'env' | 'default';
    face_retinaface_url: 'db' | 'env' | 'unset';
    face_retinaface_sha256: 'db' | 'env' | 'unset';
    face_mobilefacenet_url: 'db' | 'env' | 'unset';
    face_mobilefacenet_sha256: 'db' | 'env' | 'unset';
    ocr_worker_enabled: 'db' | 'env' | 'default';
  };
}

export interface EnrichmentTestResponse {
  ok: boolean;
  url?: string;
  error?: string;
  status?: number | null;
}

export interface EnrichmentTestDescribeResponse {
  ok: boolean;
  info?: { provider: DescribeProviderName; model: string | null };
  error?: string;
  status?: number | null;
}

// ── People (face clusters) ─────────────────────────────────────────────────

/** Camel-cased version of the server's GET /api/people row. */
export interface ApiPerson {
  id: string;
  name: string;
  faceCount: number;
  coverFaceId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/people/:id response (camel-cased). */
export interface ApiPersonDetail {
  id: string;
  name: string;
  coverFaceId: string | null;
  createdAt: string;
  updatedAt: string;
  faces: ApiPersonFace[];
}

export interface ApiPersonFace {
  assetId: string;
  faceIndex: number;
  absPath: string;
  bbox: { x: number; y: number; w: number; h: number };
  confidence: number;
}

/** Trimmed shape returned by POST /api/people. */
export interface ApiPersonSummary {
  id: string;
  name: string;
}

export interface ApiRenameResult {
  id: string;
  name: string;
  /** Set when the rename triggered a merge — points at the orphan id. */
  mergedFrom: string | null;
}

export interface ApiClusterResult {
  assigned: number;
  newPeople: number;
  scanned: number;
}

// Server-side (snake_case) shapes consumed by the rxjs map() above. Kept
// internal to the service so consumers don't see snake_case at all.
interface ApiPersonRaw {
  id: string;
  name: string;
  face_count: number;
  cover_face_id?: string | null;
  created_at: string;
  updated_at: string;
}

interface ApiPersonDetailRaw {
  id: string;
  name: string;
  cover_face_id?: string | null;
  created_at: string;
  updated_at: string;
  faces: Array<{
    asset_id: string;
    face_index: number;
    abs_path: string;
    bbox: { x: number; y: number; w: number; h: number };
    confidence: number;
  }>;
}

interface ApiPersonSummaryRaw {
  id: string;
  name: string;
}

interface ApiRenameResultRaw {
  id: string;
  name: string;
  merged_from?: string | null;
}

interface ApiClusterResultRaw {
  assigned: number;
  new_people: number;
  scanned: number;
}
