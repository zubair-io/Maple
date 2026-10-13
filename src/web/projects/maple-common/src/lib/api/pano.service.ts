// PanoService — typed HttpClient wrapper for /api/pano/* (#1231).
//
// Covers pano stitching job lifecycle + operator config.
// All methods return Observable<T> per project convention.

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';

// ── DTOs ──────────────────────────────────────────────────────────────────────

export type PanoRetention = 'keep' | 'strict';
export type PanoLocalAlign = 'mesh' | 'off';
export type PanoStrategy = 'auto' | 'rotation' | 'tile';
/** `classical` runs with no downloads; `ml` (ALIKED + LightGlue) needs the
 *  models directory and ONNX Runtime path set (#4555). */
export type PanoMatcher = 'classical' | 'ml';
export type PanoJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface PanoStitchOptions {
  retention: PanoRetention;
  localAlign: PanoLocalAlign;
  /** Only included when strategySupported is true. */
  strategy?: PanoStrategy;
}

export interface PanoStitchRequest {
  /** Server asset id hex strings, sent ONLY for selected assets the client
   *  cannot reference by absolute path (e.g. cloud-hosted assets with no local
   *  file path). The server validates each is a well-formed hex id and unions
   *  them with the ids it resolves from `assetPaths`. Disjoint from `assetPaths`
   *  at the asset level — the client never sends both for the same asset. */
  assetIds?: string[];
  /** Absolute server-side filesystem paths — the preferred reference. The server
   *  resolves each path to its server asset row (indexing on-demand when not
   *  yet indexed) after validating it lies under a registered library root.
   *  Across both fields, ≥2 distinct assets must resolve. */
  assetPaths?: string[];
  libraryId: string;
  options: PanoStitchOptions;
  /** A finished preview job whose solved alignment the job starts from, so
   *  matching is not repeated (#4580). Ignored by the server when the preview
   *  is unknown or unfinished. */
  alignmentFrom?: string;
}

export interface PanoStitchResponse {
  id: string;
  /** Number of assets that were indexed on-demand before the job was queued.
   *  Present and > 0 when the server had to index files that were not yet in
   *  the assets collection. The job proceeds normally regardless. */
  indexing?: number;
  /** Whether the stitch was handed the preview's alignment (`alignmentFrom`). */
  alignmentReused?: boolean;
}

export interface PanoJobProgress {
  current: number;
  total: number;
}

export interface PanoAlignmentVerdict {
  status: 'solved' | 'reused' | 'stale';
  stale_reason: string | null;
}

export interface PanoJobResult {
  outputAssetId: string | null;
  outputPath: string;
  stagesCompleted: number;
  alignment?: PanoAlignmentVerdict | null;
  error: string | null;
}

/** `result` of a finished `pano_preview` job. */
export interface PanoPreviewResult {
  alignment: PanoAlignmentVerdict | null;
  width: number | null;
  height: number | null;
  seconds: number | null;
}

export interface PanoJobView {
  id: string;
  kind: string;
  status: PanoJobStatus;
  progress: PanoJobProgress;
  result: (PanoJobResult & Partial<PanoPreviewResult>) | null;
  error: string | null;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
}

export type ConfigSource = 'db' | 'env' | 'unset' | 'default';

export interface PanoConfig {
  maple_cli_path: string | null;
  models_dir: string | null;
  ort_dylib_path: string | null;
  enabled: boolean;
  matcher: PanoMatcher;
  /** Whether the binary supports --strategy (probed at request time). */
  strategy_supported: boolean;
  /** Whether the binary accepts --features-engine; one without it predates the
   *  classical matcher and can only stitch with ML. */
  features_engine_supported: boolean;
  /** Whether the binary supports the quick preview (`--preview-out`, #4580). */
  preview_supported: boolean;
  source: {
    maple_cli_path: ConfigSource;
    models_dir: ConfigSource;
    ort_dylib_path: ConfigSource;
    enabled: 'db' | 'default';
    matcher: 'db' | 'default';
  };
}

export interface PanoConfigPatch {
  maple_cli_path?: string | null;
  models_dir?: string | null;
  ort_dylib_path?: string | null;
  enabled?: boolean | null;
  matcher?: PanoMatcher | null;
}

export interface PanoNotProvisionedError {
  error: 'pano_not_provisioned';
  message: string;
}

export interface PanoMlNotProvisionedError {
  error: 'pano_ml_not_provisioned';
  message: string;
}

export interface PanoCliOutdatedError {
  error: 'pano_cli_outdated';
  message: string;
}

export interface PanoJobRunningError {
  error: 'pano_job_running';
  message: string;
  jobId: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class PanoService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /** Create a pano_stitch job. Returns 201 + job id on success.
   * The observable errors on non-2xx; callers should handle 409 explicitly. */
  stitch(req: PanoStitchRequest): Observable<PanoStitchResponse> {
    return this.http.post<PanoStitchResponse>(`${this.base}/pano/stitch`, req);
  }

  /** Create a pano_preview job; a newer preview supersedes a running one.
   *  409 `pano_preview_unsupported` from an older maple-cli. */
  preview(req: PanoStitchRequest): Observable<PanoStitchResponse> {
    return this.http.post<PanoStitchResponse>(`${this.base}/pano/preview`, req);
  }

  /** The finished preview image of a `pano_preview` job. */
  previewImage(jobId: string): Observable<Blob> {
    return this.http.get(`${this.base}/pano/jobs/${encodeURIComponent(jobId)}/preview`, {
      responseType: 'blob',
    });
  }

  /** Poll job status + progress. */
  getJob(id: string): Observable<PanoJobView> {
    return this.http.get<PanoJobView>(`${this.base}/pano/jobs/${encodeURIComponent(id)}`);
  }

  /** Request cancellation of an in-flight job. */
  cancelJob(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.base}/pano/jobs/${encodeURIComponent(id)}`);
  }

  /** Read the effective pano config + strategySupported. */
  getConfig(): Observable<PanoConfig> {
    return this.http.get<PanoConfig>(`${this.base}/pano/config`);
  }

  /** Upsert pano operator config. */
  putConfig(patch: PanoConfigPatch): Observable<PanoConfig & { ok: boolean }> {
    return this.http.put<PanoConfig & { ok: boolean }>(`${this.base}/pano/config`, patch);
  }
}
