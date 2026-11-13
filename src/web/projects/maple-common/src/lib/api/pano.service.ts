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
  /** Boundary Warp strength in percent, 0 to 100. Only sent when above 0. */
  boundaryWarp?: number;
  /** Only sent when on. */
  autoCrop?: boolean;
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

/** The matcher a job ran; `matcherNote` says why it is not the one selected,
 *  e.g. ML selected but its models missing, so classical ran (#5487). */
export interface PanoMatcherUsed {
  matcher?: PanoMatcher;
  matcherNote?: string | null;
}

/** What Boundary Warp and Auto Crop did to the written image: the `edges`
 *  block of the maple-cli report, passed through unchanged. Strengths are
 *  percents. `status` is `off`, `applied`, `clamped_fold` or a `refused_*`
 *  reason; a status this build does not know is shown as no reason. */
export interface PanoEdgesReport {
  output: { width: number; height: number };
  uncovered_px: number;
  boundary_warp: {
    requested: number;
    applied: number;
    status: string;
    max_stretch: number | null;
    min_jacobian: number | null;
    predicted_coverage: number | null;
    solve_ms: number | null;
  };
  auto_crop: {
    requested: boolean;
    rect: { x: number; y: number; width: number; height: number } | null;
    invalid_px: number | null;
  };
}

export interface PanoJobResult extends PanoMatcherUsed {
  outputAssetId: string | null;
  outputPath: string;
  stagesCompleted: number;
  alignment?: PanoAlignmentVerdict | null;
  /** Null from a binary that predates Boundary Warp and Auto Crop. */
  edges?: PanoEdgesReport | null;
  error: string | null;
}

/** `result` of a finished `pano_preview` job. */
export interface PanoPreviewResult extends PanoMatcherUsed {
  alignment: PanoAlignmentVerdict | null;
  edges?: PanoEdgesReport | null;
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

export type ConfigSource = 'db' | 'env' | 'unset' | 'default' | 'bundled';

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
  /** Whether the binary supports Boundary Warp and Auto Crop (`--boundary-warp`). */
  edges_supported: boolean;
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
