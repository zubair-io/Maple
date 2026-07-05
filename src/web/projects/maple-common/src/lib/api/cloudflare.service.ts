// CloudflareService — typed HttpClient wrapper for /api/cloudflare/* (#1757).
//
// Covers the R2 thumbnail-mirror operator config (credentials + on/off
// toggle), a credential test probe, and the backfill job that mirrors
// already-indexed thumbnails to R2 (sub-issue 4). All methods return
// Observable<T> per project convention (mirrors PanoService).

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';

export interface CloudflareConfig {
  enabled: boolean;
  account_id: string | null;
  bucket: string | null;
  access_key_id: string | null;
  /** Never populated by the server — only whether a secret is saved. */
  secret_access_key_set: boolean;
}

export interface CloudflareConfigPatch {
  enabled: boolean;
  account_id?: string | null;
  bucket?: string | null;
  access_key_id?: string | null;
  /** Omit to leave the saved secret unchanged; `null` clears it; a
   * non-empty string sets a new one. */
  secret_access_key?: string | null;
}

export interface CloudflareCredentials {
  account_id: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
}

export interface CloudflareTestResult {
  ok: boolean;
  error?: string;
}

export type CloudflareBackfillJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface CloudflareBackfillResult {
  successCount: number;
  skippedCount: number;
  failedCount: number;
  failures: Array<{ assetId: string; error: string }>;
}

export interface CloudflareBackfillJob {
  id: string;
  status: CloudflareBackfillJobStatus;
  progress: { current: number; total: number };
  result: CloudflareBackfillResult | null;
  error: string | null;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
}

@Injectable({ providedIn: 'root' })
export class CloudflareService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /** Read the effective Cloudflare config (secret redacted to a boolean). */
  getConfig(): Observable<CloudflareConfig> {
    return this.http.get<CloudflareConfig>(`${this.base}/cloudflare/config`);
  }

  /** Upsert Cloudflare operator config. Validates credentials against R2
   * server-side before persisting when `enabled: true`. */
  putConfig(patch: CloudflareConfigPatch): Observable<CloudflareConfig> {
    return this.http.put<CloudflareConfig>(`${this.base}/cloudflare/config`, patch);
  }

  /** Round-trip a probe object through R2 without saving — the settings
   * page's "Test" button, for checking not-yet-saved credentials. */
  testCredentials(credentials: CloudflareCredentials): Observable<CloudflareTestResult> {
    return this.http.post<CloudflareTestResult>(`${this.base}/cloudflare/test`, credentials);
  }

  /** Queue a job that uploads every already-indexed, not-yet-mirrored
   * thumbnail to R2. Server rejects (409) unless config is enabled and
   * complete. */
  triggerBackfill(): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`${this.base}/cloudflare/backfill`, {});
  }

  /** Poll backfill job status + progress. */
  getBackfillJob(id: string): Observable<CloudflareBackfillJob> {
    return this.http.get<CloudflareBackfillJob>(
      `${this.base}/cloudflare/backfill/${encodeURIComponent(id)}`,
    );
  }

  /** Request cancellation of an in-flight backfill job. */
  cancelBackfillJob(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(
      `${this.base}/cloudflare/backfill/${encodeURIComponent(id)}`,
    );
  }
}
