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
export type PanoJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface PanoStitchOptions {
  retention: PanoRetention;
  localAlign: PanoLocalAlign;
  /** Only included when strategySupported is true. */
  strategy?: PanoStrategy;
}

export interface PanoStitchRequest {
  assetIds: string[];
  libraryId: string;
  options: PanoStitchOptions;
}

export interface PanoStitchResponse {
  id: string;
}

export interface PanoJobProgress {
  current: number;
  total: number;
}

export interface PanoJobResult {
  outputAssetId: string | null;
  outputPath: string;
  stagesCompleted: number;
  error: string | null;
}

export interface PanoJobView {
  id: string;
  kind: string;
  status: PanoJobStatus;
  progress: PanoJobProgress;
  result: PanoJobResult | null;
  error: string | null;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
}

export type ConfigSource = 'db' | 'unset' | 'default';

export interface PanoConfig {
  maple_cli_path: string | null;
  models_dir: string | null;
  ort_dylib_path: string | null;
  enabled: boolean;
  /** Whether the binary supports --strategy (probed at request time). */
  strategy_supported: boolean;
  source: {
    maple_cli_path: ConfigSource;
    models_dir: ConfigSource;
    ort_dylib_path: ConfigSource;
    enabled: 'db' | 'default';
  };
}

export interface PanoConfigPatch {
  maple_cli_path?: string | null;
  models_dir?: string | null;
  ort_dylib_path?: string | null;
  enabled?: boolean | null;
}

export interface PanoNotProvisionedError {
  error: 'pano_not_provisioned';
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
