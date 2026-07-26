// BunApiBackend — HttpClient wrapper for the Maple Self Hosted API.
//
// Endpoints documented in src/api/README.md.
// All methods return Observable<T> per best-practices (no firstValueFrom).
//
// Base URL comes from API_BASE_URL (default '/api'), so deployments behind a
// reverse proxy work without rebuilding the bundle.

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpEventType, HttpParams } from '@angular/common/http';
import { Observable, filter, map } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';
import type { DownloadProgress } from './filesystem-browse.service';
// `ObservabilityConfigResponse` lives in `../observability/observability-config.model`
// and is re-exported from the library's public-api barrel; we only need the type
// here for the method signatures below.
import type { ObservabilityConfigResponse } from '../observability/observability-config.model';
import type { NetworkConfigPatch, NetworkConfigResponse } from '../network/network-config.model';

export interface ApiFolder {
  id: string;
  path: string;
  /**
   * URL-safe slug identifying this library in the M1 addressing scheme.
   * Populated by the server once M1 (#1326) merges; optional here so the
   * client degrades gracefully on older API versions.
   */
  slug?: string;
  /** Display label — defaults to the basename of `path` on the server side. */
  label: string;
  /** Last full-scan timestamp (ISO 8601), or null if the library has never been scanned. */
  last_scan: string | null;
  /** Cached count of files indexed under this library. */
  file_count: number;
  /** When the library was registered (ISO 8601). */
  created_at: string;
}

/** A backup/mirror location for a library (mirrors the server `MirrorLocation`). */
export interface MirrorLocation {
  path: string;
  enabled: boolean;
}

/** One per-file error from a reconcile run (mirrors the server type). */
export interface MirrorReconcileError {
  path: string;
  error: string;
  at: string;
}

/** Live two-stage progress of an operator "Reconcile now" run (scan → copy). */
export interface MirrorReconcileProgress {
  phase: 'idle' | 'scanning' | 'copying';
  scan: { scanned: number; toCopy: number; upToDate: number; errors: number };
  copy: { total: number; copied: number; remaining: number; errors: number };
  currentPath: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorLog: MirrorReconcileError[];
  copiedLog: string[];
}

/** mirror_queue depth + reconcile progress, surfaced in the Backup group on the Workers settings page. */
export interface MirrorQueueStatus {
  queue: { pending: number; dead: number };
  /** Optional so older/mocked responses without reconcile progress still type-check. */
  reconcile?: MirrorReconcileProgress;
}

/** Config for the derivative-audit worker (mirrors the API `DerivativeAuditConfig`). */
export interface DerivativeAuditConfigDto {
  enabled: boolean;
  interval_ms: number;
  max_resets_per_pass: number;
  concurrency: number;
  deep_r2_enabled: boolean;
  updated_at?: number;
}

/** Last-pass summary of the derivative-audit worker. */
export interface DerivativeAuditSummaryDto {
  scanned: number;
  reArmed: number;
  byStage: Record<string, number>;
  skippedCooldown: number;
  errors: number;
  startedAt: string | null;
  finishedAt: string | null;
  running: boolean;
}

/** GET /api/derivative-audit/status payload, surfaced in the Maintenance group
 * on the Workers settings page. */
export interface DerivativeAuditStatusDto {
  config: DerivativeAuditConfigDto;
  progress: DerivativeAuditSummaryDto;
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
  /** True iff the XMP write/delete handlers have observed a sidecar
   * next to this asset. Drives the S2 "Edited" filter chip (#628).
   * Missing on legacy rows; converter coerces to `false`. */
  has_xmp?: boolean;
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
 * helper). Consumers must respect the documented units. */
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

export type ApiEnrichmentStage = 'geocode' | 'face' | 'describe';

export interface ApiEnrichment {
  geocode: ApiEnrichmentStageState;
  face: ApiEnrichmentStageState;
  describe: ApiEnrichmentStageState;
}

export interface ApiOcrMeta {
  /** The describe stage is the sole writer and stamps `'qwen2.5-vl'`. The
   * `'tesseract'` literal remains because pre-#158 installs still have
   * rows tagged that way until the describe stage re-runs them — the API
   * returns the value verbatim (no read-side rewrite). */
  engine: 'qwen2.5-vl' | 'tesseract';
  engine_version: string;
  generated_at: string;
  /** `null` for the qwen2.5-vl path. Legacy Tesseract rows carry the
   * engine's reported 0-100 mean confidence. */
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

/**
 * Structured vision metadata from the qwen3-vl describe stage.
 * Mirrors `VisionDoc` in `src/api/src/db/schema.ts`. `null` until the
 * stage has run on the asset.
 *
 * Prompt v5 classifies `is_screenshot` first and nulls every scene field
 * below when it's true (screenshot short-circuit) — that's why
 * `scene_type` / `time_of_day` / `lighting` / `weather` / `composition` /
 * `shot_type` are nullable here.
 */
export interface ApiVision {
  caption: string;
  subjects: string[];
  scene_type: 'indoor' | 'outdoor' | 'aerial' | 'macro' | 'studio' | 'mixed' | null;
  setting: string | null;
  activity: string | null;
  time_of_day:
    | 'morning'
    | 'midday'
    | 'afternoon'
    | 'golden hour'
    | 'evening'
    | 'night'
    | 'unknown'
    | null;
  lighting:
    | 'natural'
    | 'artificial'
    | 'mixed'
    | 'low-light'
    | 'backlit'
    | 'flash'
    | 'unknown'
    | null;
  weather: 'clear' | 'cloudy' | 'rainy' | 'snowy' | 'foggy' | 'indoor' | 'unknown' | null;
  mood: string;
  colors: string[];
  composition: 'wide shot' | 'close-up' | 'portrait' | 'landscape' | 'aerial' | 'macro' | null;
  text_visible: string | null;
  notable_objects: string[];
  shot_type: 'action' | 'static' | 'candid' | 'posed' | 'architectural' | 'nature' | 'event' | null;
  /** True when the image is a screenshot rather than a photograph. */
  is_screenshot: boolean;
  /** Nudity classification ladder (prompt v5): `'explicit'` auto-hides the
   * asset, `'suggestive'` does not, `'none'` is the common case. */
  nudity: 'none' | 'suggestive' | 'explicit';
  /** @deprecated Superseded by `nudity` in prompt v5. Rows written under
   * `prompt_version` <= 4 carry this instead; readers must handle both
   * until every row has been re-captioned (targetVersion 6). */
  nudity_detected?: boolean;
  /** @deprecated Dropped in prompt v5 — derivable from `scene_type`. Rows
   * written under `prompt_version` <= 4 carry this; readers must handle
   * its absence. */
  indoor_outdoor?: 'indoor' | 'outdoor';
}

export interface ApiVisionMeta {
  provider: 'ollama' | 'anthropic' | 'openai' | 'gemini';
  model: string;
  prompt_version: number;
  generated_at: string;
  raw_response_size: number;
}

/**
 * Display projection of the transcribe stage's `TranscriptDoc`
 * (`src/api/src/db/schema.ts`). `null` until the stage has run, or when
 * the asset carries no audio track. The per-segment timing array is
 * omitted server-side — the info pane renders `text` as one block.
 */
export interface ApiTranscript {
  text: string;
  language: string;
  model: string;
  duration_sec: number | null;
  generated_at: string;
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
  /** Structured vision data from the qwen3-vl describe stage. */
  vision: ApiVision | null;
  vision_meta: ApiVisionMeta | null;
  /** Speech-to-text from the transcribe stage (video/audio assets).
   * `null` for images and un-transcribed assets. */
  transcript: ApiTranscript | null;
  /** Top-level mirror of `vision.is_screenshot` — seeded by the exif
   * stage heuristic, overwritten by the describe stage's VLM verdict.
   * `null` for legacy rows indexed before #175. */
  is_screenshot: boolean | null;
  hidden?: boolean;
  hidden_reason?: 'manual' | 'nudity' | 'nudity-burst';
  hidden_ack?: boolean;
  enrichment: ApiEnrichment;
}

/** `ApiAssetDetail` plus the `slug:relPath` address `GET /api/photos/hidden`
 * additionally computes — required by `/api/xmp/batch`, which cannot resolve
 * a plain Mongo id the way `resolveAddressString` expects. `null` when the
 * asset's library has no registered slug. */
export interface ApiHiddenPhoto extends ApiAssetDetail {
  address: string | null;
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

/**
 * Server-computed RGB histogram payload. Each channel is 256 bins,
 * unnormalised counts. Consumers normalise per-channel before drawing
 * (so a single hot bin doesn't squash the rest of the curve). See
 * `GET /api/assets/:id/histogram` (#633).
 */
export interface ApiHistogram {
  r: number[];
  g: number[];
  b: number[];
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

  // --- Network settings (LAN address override) ------------------------------

  /** Current effective LAN-address config + provenance. Powers the
   * Settings → Network page (auto-detected value shown alongside any saved
   * override). */
  getNetworkConfig(): Observable<NetworkConfigResponse> {
    return this.http.get<NetworkConfigResponse>(`${this.base}/network/config`);
  }

  /** Save the LAN-address override (patch semantics — only send the fields
   * you want to change) and get the re-resolved view back. `null` clears an
   * override back to auto-detection / the server's listen port. */
  saveNetworkConfig(body: NetworkConfigPatch): Observable<NetworkConfigResponse> {
    return this.http.put<NetworkConfigResponse>(`${this.base}/network/config`, body);
  }

  // --- Mirror / backup locations (per library) -----------------------------

  getFolderMirrors(folderId: string): Observable<{ mirrors: MirrorLocation[] }> {
    return this.http.get<{ mirrors: MirrorLocation[] }>(
      `${this.base}/folders/${encodeURIComponent(folderId)}/mirror`,
    );
  }

  setFolderMirrors(
    folderId: string,
    mirrors: MirrorLocation[],
  ): Observable<{ ok: boolean; mirrors: MirrorLocation[] }> {
    return this.http.put<{ ok: boolean; mirrors: MirrorLocation[] }>(
      `${this.base}/folders/${encodeURIComponent(folderId)}/mirror`,
      { mirrors },
    );
  }

  testMirrorPath(path: string): Observable<{ ok: boolean; path?: string; error?: string }> {
    return this.http.post<{ ok: boolean; path?: string; error?: string }>(
      `${this.base}/mirror/test`,
      { path },
    );
  }

  getMirrorStatus(): Observable<MirrorQueueStatus> {
    return this.http.get<MirrorQueueStatus>(`${this.base}/mirror/status`);
  }

  retryDeadMirrors(): Observable<{ ok: boolean; revived: number }> {
    return this.http.post<{ ok: boolean; revived: number }>(`${this.base}/mirror/retry-dead`, {});
  }

  /** Kick a full reconcile (scan → copy) now; poll getMirrorStatus() for live
   * two-stage progress. */
  runMirrorReconcile(): Observable<{
    started: boolean;
    phase: MirrorReconcileProgress['phase'];
    reason?: string;
  }> {
    return this.http.post<{
      started: boolean;
      phase: MirrorReconcileProgress['phase'];
      reason?: string;
    }>(`${this.base}/mirror/reconcile`, {});
  }

  /** Derivative-audit worker: current config + last-pass progress. */
  getDerivativeAuditStatus(): Observable<DerivativeAuditStatusDto> {
    return this.http.get<DerivativeAuditStatusDto>(`${this.base}/derivative-audit/status`);
  }

  /** Patch the derivative-audit config (partial). */
  setDerivativeAuditConfig(
    patch: Partial<DerivativeAuditConfigDto>,
  ): Observable<{ ok: boolean; config: DerivativeAuditConfigDto }> {
    return this.http.put<{ ok: boolean; config: DerivativeAuditConfigDto }>(
      `${this.base}/derivative-audit/config`,
      patch,
    );
  }

  /** Kick an audit pass now; poll getDerivativeAuditStatus() for progress. */
  runDerivativeAudit(): Observable<{ started: boolean; reason?: string }> {
    return this.http.post<{ started: boolean; reason?: string }>(
      `${this.base}/derivative-audit/run`,
      {},
    );
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
   * the enrichment outputs (place, faces, description, vision) the info-pane
   * needs. Snake_case fields pass through untouched. */
  getAssetDetails(assetId: string): Observable<ApiAssetDetail> {
    return this.http.get<ApiAssetDetail>(`${this.base}/assets/${assetId}`);
  }

  /**
   * Detail DTO for an asset identified by its `slug:relPath` address rather
   * than its Mongo id.
   *
   * The browse grid lists through `/api/fs/dir-fast`, which carries no Mongo
   * id, so grid-opened assets can only be addressed this way. 404s when the
   * path resolves on disk but isn't indexed.
   */
  getAssetDetailsByAddress(address: string): Observable<ApiAssetDetail> {
    return this.http.get<ApiAssetDetail>(`${this.base}/assets/by-address`, {
      params: new HttpParams().set('address', address),
    });
  }

  /** Manually override the reverse-geocoded place. `null` clears the
   * override; the next worker run will repopulate. Server recomputes
   * `search_blob` atomically using the same expression the geocode worker
   * uses. */
  setAssetPlaceOverride(assetId: string, place: ApiPlace | null): Observable<void> {
    return this.http.put<void>(`${this.base}/assets/${assetId}/place`, { place });
  }

  /** Manually override the LLM caption. Pass `null` to clear. */
  setAssetDescriptionOverride(assetId: string, text: string | null): Observable<void> {
    return this.http.put<void>(`${this.base}/assets/${assetId}/description`, { text });
  }

  /** Reset a per-stage enrichment state so the worker re-runs on its next
   * tick: `done_at` cleared, `version` bumped by 1, attempt counter +
   * dead-letter timestamp wiped, lock released. */
  requeueEnrichmentStage(
    assetId: string,
    stage: ApiEnrichmentStage,
  ): Observable<ApiRequeueResponse> {
    return this.http.post<ApiRequeueResponse>(`${this.base}/assets/${assetId}/enrichment/requeue`, {
      stage,
    });
  }

  /** Aggregate worker status (one entry per stage). The detail panel uses
   * the `config.paused` flag to distinguish "queued and waiting" from
   * "no worker will ever pick this up" — a stage paused on first boot is
   * the difference between an honest "Worker paused" badge and a misleading
   * "Pending" badge that would otherwise stick forever. */
  getWorkerStatus(): Observable<ApiWorkerStatus> {
    return this.http.get<ApiWorkerStatus>(`${this.base}/workers/status`);
  }

  getDisplayConfig(): Observable<{ show_hidden_images: boolean }> {
    return this.http.get<{ show_hidden_images: boolean }>(`${this.base}/display/config`);
  }

  saveDisplayConfig(config: { show_hidden_images: boolean }): Observable<{ ok: boolean }> {
    return this.http.put<{ ok: boolean }>(`${this.base}/display/config`, config);
  }

  acknowledgeHidden(assetId: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/assets/${assetId}/hidden-ack`, {});
  }

  getHiddenPhotos(onlyNew?: boolean): Observable<ApiHiddenPhoto[]> {
    return this.http.get<ApiHiddenPhoto[]>(`${this.base}/photos/hidden`, {
      params: onlyNew ? { onlyNew: 'true' } : undefined,
    });
  }

  /**
   * Stream an asset's RAW bytes by Mongo asset id.
   *
   * The emission contract is unchanged — the observable emits exactly one
   * value, the `ArrayBuffer`, then completes — so `firstValueFrom` callers
   * keep working. Pass `onProgress` to additionally receive download progress
   * frames as the body streams in (used to drive the editor's open progress
   * bar). Without it, the request still buffers silently as before.
   */
  getRawBytes(
    assetId: string,
    onProgress?: (p: DownloadProgress) => void,
  ): Observable<ArrayBuffer> {
    const url = `${this.base}/assets/${assetId}/raw`;

    if (!onProgress) {
      return this.http.get(url, { responseType: 'arraybuffer' });
    }

    return this.http
      .get(url, { responseType: 'arraybuffer', observe: 'events', reportProgress: true })
      .pipe(
        // Fire the progress callback as a side effect, then pass through only
        // the final Response body so the observable still emits one ArrayBuffer.
        map((event) => {
          if (event.type === HttpEventType.DownloadProgress) {
            onProgress({ loaded: event.loaded, total: event.total ?? null });
            return null;
          }
          if (event.type === HttpEventType.Response) {
            // A successful download always carries a body. A null/missing
            // body here means the request broke or aborted mid-stream — fail
            // fast with a clear error instead of handing back a 0-byte buffer
            // that would later surface as a baffling RAW decode error.
            if (event.body == null) {
              throw new Error(
                `getRawBytes: empty response body for asset ${assetId} (status ${event.status})`,
              );
            }
            return event.body;
          }
          return null;
        }),
        filter((body): body is ArrayBuffer => body !== null),
      );
  }

  /** `GET /api/assets/:id/thumb` — the single fixed thumb tier. Sent no `size`
   * param: the route never read one (it resolves a per-asset cache path with no
   * size dimension), so the `?size=320x320` this used to append was inert
   * (#2220). */
  getThumb(assetId: string): Observable<Blob> {
    return this.http.get(`${this.base}/assets/${assetId}/thumb`, {
      responseType: 'blob',
    });
  }

  /**
   * Fetch the server-computed RGB histogram for an asset. Three 256-bin
   * arrays — applied with the asset's current XMP, so the cache key on
   * the server is `(raw_mtime, sidecar_mtime)` and a re-edit invalidates
   * automatically (see `GET /api/assets/:id/histogram`, #633).
   *
   * Returns 503 on the server if the libraw_ffi dylib is unavailable;
   * the component falls back to the placeholder block in that case.
   */
  getHistogram(assetId: string): Observable<ApiHistogram> {
    return this.http.get<ApiHistogram>(`${this.base}/assets/${assetId}/histogram`);
  }

  /**
   * Write the XMP sidecar that lives next to `path`.
   *
   * Path-keyed (NOT asset-id-keyed) — see slice 4 of #193 for why. The path
   * goes through `encodeURIComponent` because absolute paths legitimately
   * contain `/`, spaces, and other URL-meaningful characters.
   */
  putXmp(path: string, xml: string): Observable<void> {
    return this.http.post<void>(`${this.base}/xmp?path=${encodeURIComponent(path)}`, xml, {
      headers: { 'Content-Type': 'application/xml' },
    });
  }

  /** Delete the XMP sidecar at `path`. */
  deleteXmp(path: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/xmp?path=${encodeURIComponent(path)}`);
  }

  /**
   * Upload a rendered preview for the asset at `path` (the ORIGINAL asset's
   * path, not the cache path — the server derives
   * `<dir>/.maple/previews/<filename>.avif` from it, mirroring `putXmp`).
   *
   * `contentType` is `image/avif` when this browser can genuinely
   * canvas-encode AVIF (`canEncodeAvif`), or `image/jpeg` otherwise — the
   * server (#2018) accepts either, transcoding a JPEG body to AVIF
   * server-side via the same isolated sharp pipeline the index-time preview
   * stage uses. See `routes/preview.ts`'s module doc on the API side.
   */
  putPreview(path: string, body: Blob, contentType: 'image/avif' | 'image/jpeg'): Observable<void> {
    return this.http.put<void>(`${this.base}/preview?path=${encodeURIComponent(path)}`, body, {
      headers: { 'Content-Type': contentType },
    });
  }

  /** Force a re-scan of one library folder. Resets every stage's version to 0
   * for all assets under the folder path tree so the pipeline re-processes them.
   * Returns immediately; the workers pick up the reset docs on their next poll. */
  rescanFolder(
    folderId: string,
  ): Observable<{ ok: boolean; folderId: string; path: string; reset: number; error?: string }> {
    return this.http.post<{
      ok: boolean;
      folderId: string;
      path: string;
      reset: number;
      error?: string;
    }>(`${this.base}/folders/${encodeURIComponent(folderId)}/rescan`, {});
  }

  /** Content-aware re-discover of one library folder, for auto-scan-on-open
   * (#804). Re-walks the folder tree so a moved/new file is relinked onto its
   * existing asset (stages then resume); unlike `rescanFolder` this does NOT
   * zero stage versions, so opening a folder doesn't reprocess the library.
   * Server-side gated by `last_scan` — a folder scanned within a recent window
   * short-circuits (`skipped: 'recent'`) without re-walking. */
  scanFolder(folderId: string): Observable<{
    ok: boolean;
    folderId?: string;
    path?: string;
    skipped?: 'recent';
    last_scan?: string;
    error?: string;
  }> {
    return this.http.post<{
      ok: boolean;
      folderId?: string;
      path?: string;
      skipped?: 'recent';
      last_scan?: string;
      error?: string;
    }>(`${this.base}/folders/${encodeURIComponent(folderId)}/scan`, {});
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
  saveEnrichmentConfig(body: {
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
    transcribe_model_tier?: 'tiny.en' | 'base.en' | 'small.en' | 'medium.en' | 'large-v3' | null;
    // ── Face worker (Phase 5) ─────────────────────────────────────
    face_worker_enabled?: boolean | null;
    // ── Face model paths (Phase 5) ────────────────────────────────
    /** `null` clears the override back to env / built-in default. */
    face_model_dir?: string | null;
    /** SCRFD-10G detector + ArcFace R100 recognizer (InsightFace antelopev2).
     * Used only when the file isn't already on disk under face_model_dir. */
    face_detector_url?: string | null;
    face_detector_sha256?: string | null;
    face_recognizer_url?: string | null;
    face_recognizer_sha256?: string | null;
    /** Minimum face size (normalised [0,1) on the 640-px detection frame).
     * `null` clears back to the built-in default (0.06). */
    face_min_detection_size?: number | null;
    // ── Search index (Phase 7) ────────────────────────────────────
    /** Meilisearch sidecar URL. `null`/empty clears back to env / disabled. */
    meilisearch_url?: string | null;
    /** Meilisearch API key (write-only secret). Non-empty string sets it;
     * `null` clears back to env; omitted/empty leaves the saved key alone. */
    meilisearch_api_key?: string | null;
    meilisearch_task_timeout_seconds?: number | null;
    service_search_rate_limit_per_minute?: number | null;
  }): Observable<EnrichmentConfigResponse> {
    return this.http.put<EnrichmentConfigResponse>(`${this.base}/enrichment/config`, body);
  }

  /** Health-check an arbitrary Nominatim URL without saving. Used for the
   * "Test connection" button in the settings UI. */
  testNominatim(url: string): Observable<EnrichmentTestResponse> {
    return this.http.post<EnrichmentTestResponse>(`${this.base}/enrichment/test`, {
      nominatim_url: url,
    });
  }

  /** Health-check an arbitrary Meilisearch URL without saving. Pass
   * `apiKey` to probe with a freshly-typed (not-yet-saved) key; omit it to
   * let the server fall back to the saved key / `MAPLE_MEILISEARCH_API_KEY`
   * env var. The key is write-only — never echoed back. */
  testMeilisearch(url: string, apiKey?: string | null): Observable<EnrichmentTestResponse> {
    return this.http.post<EnrichmentTestResponse>(`${this.base}/enrichment/test-meili`, {
      meilisearch_url: url,
      ...(apiKey ? { api_key: apiKey } : {}),
    });
  }

  /** Health-check a describe provider without saving. The `api_key` field
   * is write-only — pass it for paid providers when the user is testing
   * a freshly-typed key; the server never echoes it back. */
  testDescribeProvider(body: {
    provider: DescribeProviderName;
    url?: string | null;
    model?: string | null;
    api_key?: string | null;
  }): Observable<EnrichmentTestDescribeResponse> {
    return this.http.post<EnrichmentTestDescribeResponse>(
      `${this.base}/enrichment/test-describe`,
      body,
    );
  }

  // -------------------------------------------------------------------------
  // Sub-threshold face cleanup (#1607). Audit/purge existing faces whose bbox
  // is below the configured `face_min_detection_size`, WITHOUT a re-detect
  // (which would null every person_id and destroy manual curation).
  // -------------------------------------------------------------------------

  /** Dry-run audit — scans every asset and reports the sub-threshold-face
   * breakdown WITHOUT writing anything. Safe to call repeatedly. */
  auditSubthresholdFaces(): Observable<SubthresholdFaceAuditResponse> {
    return this.http.post<SubthresholdFaceAuditResponse>(
      `${this.base}/admin/faces/purge-subthreshold`,
      {},
    );
  }

  /** Apply — remove sub-threshold faces. Default removes only unassigned
   * faces; `includeAssigned` also removes manually-assigned tiny faces.
   * Hidden faces are always preserved server-side. */
  purgeSubthresholdFaces(includeAssigned: boolean): Observable<SubthresholdFacePurgeResponse> {
    const qs = includeAssigned ? '?apply=true&includeAssigned=true' : '?apply=true';
    return this.http.post<SubthresholdFacePurgeResponse>(
      `${this.base}/admin/faces/purge-subthreshold${qs}`,
      {},
    );
  }

  // -------------------------------------------------------------------------
  // Observability — SigNoz / OpenTelemetry config (#713). The web client pulls
  // this, caches it to IndexedDB, and wires the OTel web SDK to export traces +
  // logs DIRECTLY to the self-hosted SigNoz OTLP/HTTP endpoint. The `source`
  // field says whether each value came from the DB row, an env var, or is unset.
  // -------------------------------------------------------------------------

  /** Resolved SigNoz target for the web client (OTLP/HTTP base + ingestion
   * key + per-signal toggles). Read on startup, then cached to IndexedDB so a
   * subsequent cold load can init telemetry without waiting on the network. */
  getObservabilityConfig(): Observable<ObservabilityConfigResponse> {
    return this.http.get<ObservabilityConfigResponse>(`${this.base}/observability/config`);
  }

  /** Save the observability config (persisted server-side, behind requireAuth)
   * and get the re-resolved view back. The PUT is patch semantics — every
   * field is optional: send only the ones you want to change. `ingestion_key`
   * is write-only: a non-empty string sets it, `null` clears it back to env,
   * omitting it leaves the saved key untouched. */
  saveObservabilityConfig(body: {
    enabled?: boolean | null;
    endpoint?: string | null;
    ingestion_key?: string | null;
    service_namespace?: string | null;
    traces_enabled?: boolean | null;
    logs_enabled?: boolean | null;
    metrics_enabled?: boolean | null;
    sample_ratio?: number | null;
  }): Observable<ObservabilityConfigResponse> {
    return this.http.put<ObservabilityConfigResponse>(`${this.base}/observability/config`, body);
  }

  /** Health-check an OTLP/HTTP endpoint (+ optional ingestion key) without
   * saving. Backs the "Send test event" / connection-probe affordance in the
   * Settings page. The key is write-only — never echoed back. */
  testObservability(body: {
    endpoint: string;
    ingestion_key?: string | null;
  }): Observable<ObservabilityTestResponse> {
    return this.http.post<ObservabilityTestResponse>(`${this.base}/observability/test`, body);
  }

  // -------------------------------------------------------------------------
  // People — face-cluster identities. The `/people` UI consumes these.
  // -------------------------------------------------------------------------

  listPeople(): Observable<ApiPerson[]> {
    return (
      this.http
        .get<ApiPersonRaw[]>(`${this.base}/people`)
        // Normalise snake_case → camelCase for the UI layer. Done here so
        // every component that consumes the service gets the same shape.
        .pipe(map((rows) => rows.map(normalisePerson)))
    );
  }

  /** Soft-hidden people — the Hidden page. Same wire shape as
   * `listPeople`, so it shares the `ApiPerson` normaliser. */
  listHiddenPeople(): Observable<ApiPerson[]> {
    return this.http
      .get<ApiPersonRaw[]>(`${this.base}/people/hidden`)
      .pipe(map((rows) => rows.map(normalisePerson)));
  }

  getPerson(id: string, page?: { offset: number; limit: number }): Observable<ApiPersonDetail> {
    const params =
      page != null
        ? new HttpParams().set('offset', String(page.offset)).set('limit', String(page.limit))
        : undefined;
    return this.http
      .get<ApiPersonDetailRaw>(`${this.base}/people/${id}`, params ? { params } : undefined)
      .pipe(
        map((r) => ({
          id: r.id,
          name: r.name,
          coverAssetId: r.cover_asset_id ?? null,
          coverBbox: r.cover_bbox ?? null,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          offset: r.offset ?? 0,
          limit: r.limit ?? 50,
          faces: r.faces.map((f) => ({
            assetId: f.asset_id,
            faceIndex: f.face_index,
            absPath: f.abs_path,
            bbox: f.bbox,
            confidence: f.confidence,
          })),
          suggestedMerge: r.suggested_merge
            ? {
                personId: r.suggested_merge.person_id,
                name: r.suggested_merge.name,
                coverAssetId: r.suggested_merge.cover_asset_id,
                coverBbox: r.suggested_merge.cover_bbox,
                score: r.suggested_merge.score,
              }
            : null,
        })),
      );
  }

  /** Set a face as the person's cover. The bbox is read server-side from the
   * asset doc — the client supplies only `assetId` + `faceIndex`. */
  setPersonCover(id: string, assetId: string, faceIndex: number): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`${this.base}/people/${id}/cover`, {
      asset_id: assetId,
      face_index: faceIndex,
    });
  }

  createPerson(body: { name: string }): Observable<ApiPersonSummary> {
    return this.http
      .post<ApiPersonSummaryRaw>(`${this.base}/people`, body)
      .pipe(map((r) => ({ id: r.id, name: r.name })));
  }

  /** Returns the survivor + the orphan id when a merge happened. */
  renamePerson(id: string, name: string): Observable<ApiRenameResult> {
    return this.http.put<ApiRenameResultRaw>(`${this.base}/people/${id}`, { name }).pipe(
      map((r) => ({
        id: r.id,
        name: r.name,
        mergedFrom: r.merged_from ?? null,
      })),
    );
  }

  /** Merge source people INTO a target — the target survives (keeps id /
   * cover / created_at). Returns the survivor + counts. */
  mergePeople(targetId: string, sourceIds: string[]): Observable<ApiMergeResult> {
    return this.http
      .post<ApiMergeResultRaw>(`${this.base}/people/merge`, {
        target_id: targetId,
        source_ids: sourceIds,
      })
      .pipe(
        map((r) => ({
          id: r.id,
          name: r.name,
          mergedCount: r.merged_count,
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
    return this.http.post<ApiClusterResultRaw>(`${this.base}/people/cluster`, {}).pipe(
      map((r) => ({
        assigned: r.assigned,
        newPeople: r.new_people,
        scanned: r.scanned,
      })),
    );
  }

  /** Soft-hide a person — keeps faces assigned + the row alive; the
   * person leaves the normal list and moves to the Hidden page. Server
   * returns `{ ok: true }`. */
  hidePerson(id: string): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`${this.base}/people/${id}/hide`, {});
  }

  /** Restore a hidden person back into the normal list. */
  unhidePerson(id: string): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`${this.base}/people/${id}/unhide`, {});
  }

  /** Permanently mark a merge suggestion "not a match" — clears it
   * server-side on both people and suppresses the pair on future
   * clustering runs. */
  dismissMergeSuggestion(id: string, otherId: string): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`${this.base}/people/${id}/dismiss-merge-suggestion`, {
      other_id: otherId,
    });
  }
}

/** Map the wire's snake_case people-list row → the UI's camelCase
 * `ApiPerson`. Shared by `listPeople` and `listHiddenPeople` (identical
 * shapes). */
function normalisePerson(r: ApiPersonRaw): ApiPerson {
  return {
    id: r.id,
    name: r.name,
    faceCount: r.face_count,
    coverAssetId: r.cover_asset_id ?? null,
    coverAddress: r.cover_address ?? null,
    coverAbsPath: r.cover_abs_path ?? null,
    coverBbox: r.cover_bbox ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    hasMergeSuggestion: r.has_merge_suggestion,
  };
}

export type DescribeProviderName = 'ollama' | 'anthropic' | 'openai' | 'gemini';

/** Sub-threshold face-cleanup audit/apply response (#1607). The audit
 * (dry-run) omits `applied`; the apply call includes it. */
export interface SubthresholdFaceAuditResponse {
  /** The `face_min_detection_size` threshold the scan used. */
  threshold: number;
  mode: 'dry-run' | 'apply:unassigned-only' | 'apply:all';
  assetsScanned: number;
  assetsAffected: number;
  /** Sub-threshold faces split by curation state. Hidden faces are counted
   * separately and are always preserved by the purge. */
  subThresholdFaces: {
    unassigned: number;
    assigned: number;
    hidden: number;
    total: number;
  };
  policy: {
    removesUnassigned: boolean;
    removesAssigned: boolean;
    preservesHidden: boolean;
  };
  /** People who would lose (or lost) manually-assigned sub-threshold faces. */
  affectedPeople: Array<{ personId: string; subThresholdFaces: number }>;
}

/** Apply response — the audit shape plus the realised `applied` stats. */
export interface SubthresholdFacePurgeResponse extends SubthresholdFaceAuditResponse {
  applied: {
    facesRemoved: number;
    assetsUpdated: number;
    personCountsRecomputed: number;
    personRecomputes: Array<{ personId: string; newCount: number }>;
  };
}

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
  transcribe_model_tier: 'tiny.en' | 'base.en' | 'small.en' | 'medium.en' | 'large-v3';
  /** Phase 5 face worker. Default false until the operator opts in. */
  face_worker_enabled: boolean;
  /** Resolved model dir (DB → env → ~/.maple/models/). Always populated. */
  face_model_dir: string;
  /** `null` when neither DB nor env supplied a download URL. The worker then
   * uses the file already on disk under face_model_dir, or — if it's missing —
   * zero-config auto-downloads the InsightFace antelopev2 bundle (unless
   * `MAPLE_FACE_NO_AUTO_DOWNLOAD=true`). Detector = SCRFD-10G (scrfd_10g.onnx);
   * recognizer = ArcFace R100 (arcface_r100_glint360k.onnx), same bundle. */
  face_detector_url: string | null;
  face_detector_sha256: string | null;
  face_recognizer_url: string | null;
  face_recognizer_sha256: string | null;
  /** Resolved minimum face-size threshold. Always a number on the wire
   * (default 0.06). Detections whose shorter bbox side is below this value
   * (normalised [0,1) on the 640-px frame) are dropped before persisting. */
  face_min_detection_size: number;
  /** Meilisearch sidecar URL (DB → env → null). `null` disables the sidecar;
   * search then falls back to the Mongo `$text` path. */
  meilisearch_url: string | null;
  /** Whether a Meilisearch API key is configured (DB or env). The key itself
   * is a secret and is never sent on the wire — only this boolean. */
  meilisearch_api_key_set: boolean;
  /** Maximum wait for one asynchronous Meilisearch indexing task. */
  meilisearch_task_timeout_seconds?: number;
  /** Per-service-key request budget for POST /api/search/assets. */
  service_search_rate_limit_per_minute?: number;
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
    detector: { path: string; present: boolean; bytes: number };
    recognizer: { path: string; present: boolean; bytes: number };
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
    transcribe_model_tier: 'db' | 'default';
    face_worker_enabled: 'db' | 'env' | 'default';
    face_model_dir: 'db' | 'env' | 'default';
    face_detector_url: 'db' | 'env' | 'unset';
    face_detector_sha256: 'db' | 'env' | 'unset';
    face_recognizer_url: 'db' | 'env' | 'unset';
    face_recognizer_sha256: 'db' | 'env' | 'unset';
    face_min_detection_size: 'db' | 'default';
    meilisearch_url: 'db' | 'env' | 'unset';
    meilisearch_api_key: 'db' | 'env' | 'unset';
    meilisearch_task_timeout_seconds?: 'db' | 'default';
    service_search_rate_limit_per_minute?: 'db' | 'default';
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

/** Result of probing a SigNoz OTLP/HTTP endpoint (`POST /observability/test`). */
export interface ObservabilityTestResponse {
  ok: boolean;
  endpoint?: string;
  error?: string;
  status?: number | null;
  /** Actionable hint when the probe looks misconfigured — e.g. "use :4318".
   * Already folded into `error`; exposed separately so a UI can highlight it. */
  recommendation?: string;
}

// ── People (face clusters) ─────────────────────────────────────────────────

/** Camel-cased version of the server's GET /api/people row. */
export interface ApiPerson {
  id: string;
  name: string;
  faceCount: number;
  coverAssetId: string | null;
  /** `slug:relPath` address of the cover asset. Use with `LibrarySource.thumbUrl`
   * (→ `/api/thumb/:slug/*`) for cache-coherent thumbnail fetches. Optional:
   * null when the cover asset is missing, absent when the server is pre-M2. */
  coverAddress?: string | null;
  /** Absolute filesystem path of the cover asset. Kept for backward compat;
   * prefer `coverAddress` where available. */
  coverAbsPath: string | null;
  /** Bbox of the cover face on the cover asset, in normalised `[0,1]`.
   * The UI applies the same crop transform it uses for detail-panel
   * faces. Null for manually-created people with no faces yet (or
   * pre-backfill rows). */
  coverBbox: Bbox | null;
  createdAt: string;
  updatedAt: string;
  hasMergeSuggestion: boolean;
}

/** GET /api/people/:id response (camel-cased). */
export interface ApiPersonDetail {
  id: string;
  name: string;
  coverAssetId: string | null;
  coverBbox: Bbox | null;
  createdAt: string;
  updatedAt: string;
  /** Offset of this page (echoed from the server response). Optional so
   * direct constructions / fixtures that don't paginate stay valid;
   * `getPerson` always populates it. */
  offset?: number;
  /** Page size used for this fetch (echoed from the server response).
   * Optional for the same reason as `offset`. */
  limit?: number;
  faces: ApiPersonFace[];
  suggestedMerge: ApiMergeSuggestion | null;
}

export interface ApiPersonFace {
  assetId: string;
  faceIndex: number;
  absPath: string;
  bbox: Bbox;
  confidence: number;
}

/** A candidate person the server thinks is the same real-world identity as
 * the one being viewed — surfaced by the clustering job's pairwise pass.
 * Null when there's no unsuppressed suggestion. */
export interface ApiMergeSuggestion {
  personId: string;
  name: string;
  coverAssetId: string | null;
  coverBbox: Bbox | null;
  score: number;
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

/** Result of POST /api/people/merge (camel-cased). */
export interface ApiMergeResult {
  id: string;
  name: string;
  mergedCount: number;
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
  cover_address?: string | null;
  cover_abs_path?: string | null;
  cover_bbox?: Bbox | null;
  created_at: string;
  updated_at: string;
  has_merge_suggestion: boolean;
}

interface ApiPersonDetailRaw {
  id: string;
  name: string;
  cover_asset_id?: string | null;
  cover_bbox?: Bbox | null;
  created_at: string;
  updated_at: string;
  offset?: number;
  limit?: number;
  faces: Array<{
    asset_id: string;
    face_index: number;
    abs_path: string;
    bbox: Bbox;
    confidence: number;
  }>;
  suggested_merge: ApiMergeSuggestionRaw | null;
}

interface ApiMergeSuggestionRaw {
  person_id: string;
  name: string;
  cover_asset_id: string | null;
  cover_bbox: Bbox | null;
  score: number;
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

interface ApiMergeResultRaw {
  id: string;
  name: string;
  merged_count: number;
}

interface ApiClusterResultRaw {
  assigned: number;
  new_people: number;
  scanned: number;
}
