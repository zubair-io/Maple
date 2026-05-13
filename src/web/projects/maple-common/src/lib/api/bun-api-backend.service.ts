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

/** Axis-aligned bounding box. Coordinate space is set by the producer
 * and documented at the use site — face bboxes are normalised `[0,1]`
 * proportions of the source image (used as CSS percentages by the crop
 * helper), OCR word bboxes are pixels relative to the thumbnail. The
 * shape is the same so the arithmetic is shared; consumers must respect
 * the documented units. */
export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

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
  bbox: Bbox;
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
  /** Overall mean confidence reported by the engine, 0–100. `null` for
   * legacy rows written before per-word capture landed. */
  mean_confidence?: number | null;
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

/** Per-stage entry from GET /api/workers/status. Only the fields the
 * detail panel needs are typed — the API returns more (inFlight,
 * throughput, dead counts, etc.) but those belong to the workers admin
 * page. */
export interface ApiWorkerStatusStage {
  name: string;
  /** "running" | "paused" | "starting" | "exited" | "errored" | … —
   * surfaced verbatim so we can defensively widen later. */
  status: string;
  config: { paused?: boolean } | null;
}

export interface ApiWorkerStatus {
  stages: ApiWorkerStatusStage[];
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

  /** Aggregate worker status (one entry per stage). The detail panel uses
   * the `config.paused` flag to distinguish "queued and waiting" from
   * "no worker will ever pick this up" — a stage paused on first boot is
   * the difference between an honest "Worker paused" badge and a misleading
   * "Pending" badge that would otherwise stick forever. */
  getWorkerStatus(): Observable<ApiWorkerStatus> {
    return this.http.get<ApiWorkerStatus>(`${this.base}/workers/status`);
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

  /** Force a re-scan of one library folder. Resets every stage's version to 0
   * for all assets under the folder path tree so the pipeline re-processes them.
   * Returns immediately; the workers pick up the reset docs on their next poll. */
  rescanFolder(
    folderId: string,
  ): Observable<{ ok: boolean; folderId: string; path: string; reset: number; error?: string }> {
    return this.http.post<{ ok: boolean; folderId: string; path: string; reset: number; error?: string }>(
      `${this.base}/folders/${encodeURIComponent(folderId)}/rescan`,
      {},
    );
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
          coverAssetId: r.cover_asset_id ?? null,
          coverAbsPath: r.cover_abs_path ?? null,
          coverBbox: r.cover_bbox ?? null,
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
        coverAssetId: r.cover_asset_id ?? null,
        coverBbox: r.cover_bbox ?? null,
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

  /** Mark a face as hidden — excluded from clustering and every person
   * panel. Server-side sets both `hidden=true` and `person_id=null` in
   * one write. */
  hideFace(assetId: string, faceIndex: number): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`${this.base}/people/hide`, {
      asset_id: assetId,
      face_index: faceIndex,
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
  coverAssetId: string | null;
  /** Absolute filesystem path of the cover asset. Null when the cover
   * asset is missing — falls back to `coverAssetId` lookup at the call
   * site. Surfaced so the web can hit `/api/fs/thumb?path=…` (the URL
   * /browse uses) for cache reuse. */
  coverAbsPath: string | null;
  /** Bbox of the cover face on the cover asset, in normalised `[0,1]`.
   * The UI applies the same crop transform it uses for detail-panel
   * faces. Null for manually-created people with no faces yet (or
   * pre-backfill rows). */
  coverBbox: Bbox | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/people/:id response (camel-cased). */
export interface ApiPersonDetail {
  id: string;
  name: string;
  coverAssetId: string | null;
  coverBbox: Bbox | null;
  createdAt: string;
  updatedAt: string;
  faces: ApiPersonFace[];
}

export interface ApiPersonFace {
  assetId: string;
  faceIndex: number;
  absPath: string;
  bbox: Bbox;
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
  cover_asset_id?: string | null;
  cover_abs_path?: string | null;
  cover_bbox?: Bbox | null;
  created_at: string;
  updated_at: string;
}

interface ApiPersonDetailRaw {
  id: string;
  name: string;
  cover_asset_id?: string | null;
  cover_bbox?: Bbox | null;
  created_at: string;
  updated_at: string;
  faces: Array<{
    asset_id: string;
    face_index: number;
    abs_path: string;
    bbox: Bbox;
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
