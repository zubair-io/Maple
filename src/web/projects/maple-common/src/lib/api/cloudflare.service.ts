// CloudflareService — typed HttpClient wrapper for /api/cloudflare/* (#1757).
//
// Covers the R2 thumbnail-mirror operator config (credentials + on/off
// toggle) and a credential test probe. All methods return Observable<T>
// per project convention (mirrors PanoService).
//
// Mirroring thumbnails to R2 is the `cf-thumb-sync` pipeline stage, not a
// job triggered from this service — its progress/pause/resume controls
// live on Settings → Workers via the generic worker-status API, same as
// every other stage.

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
}
