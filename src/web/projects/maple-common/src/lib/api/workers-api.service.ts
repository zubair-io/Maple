// WorkersApiService — typed HttpClient wrapper for /api/workers/*.
//
// All methods return Observable<T> per project convention.
// Consumed by WorkersComponent for both polling (getStatus) and per-stage
// runtime edits (patchConfig).

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';

export interface WorkerConfig {
  concurrency: number;
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
  paused: boolean;
  last_seen_target_version: number;
}

/** API status payload — one entry per stage from GET /api/workers/status. */
export interface StageStatus {
  name: string;
  status: 'running' | 'paused' | 'error' | 'starting' | 'restarting' | 'stopped';
  /** Dispatched but not yet completed docs. */
  inFlight: number;
  /** Configured concurrency (= config.concurrency). */
  configured: number;
  /** Claim-query count — docs waiting to be processed. */
  pending: number;
  /** Dead-lettered doc count. */
  dead: number;
  /** Docs completed per minute, rolling window. */
  throughput: number;
  lastError: string | null;
  /** Persisted operator config for this stage. Null when not yet seeded. */
  config: WorkerConfig | null;
  /** Batch limit (= config.batchSize). */
  batchSize: number;
}

export interface WorkersStatusResponse {
  stages: StageStatus[];
}

/** One row in the dead-letter list — returned by GET /api/workers/:name/dead. */
export interface DeadDoc {
  id: string;
  abs_path: string | null;
  last_error: string | null;
  attempts: number;
  /** ISO 8601 string, or null if the doc never reached a terminal state. */
  processed_at: string | null;
}

export interface DeadListResponse {
  items: DeadDoc[];
}

@Injectable({ providedIn: 'root' })
export class WorkersApiService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  getStatus(): Observable<WorkersStatusResponse> {
    return this.http.get<WorkersStatusResponse>(`${this.base}/workers/status`);
  }

  listDead(name: string, limit = 50): Observable<DeadListResponse> {
    return this.http.get<DeadListResponse>(
      `${this.base}/workers/${encodeURIComponent(name)}/dead?limit=${limit}`,
    );
  }

  pause(name: string): Observable<void> {
    return this.http.post<void>(`${this.base}/workers/${encodeURIComponent(name)}/pause`, null);
  }

  resume(name: string): Observable<void> {
    return this.http.post<void>(`${this.base}/workers/${encodeURIComponent(name)}/resume`, null);
  }

  retryDead(name: string): Observable<{ ok: boolean; reset: number }> {
    return this.http.post<{ ok: boolean; reset: number }>(
      `${this.base}/workers/${encodeURIComponent(name)}/retry-dead`,
      null,
    );
  }

  patchConfig(
    name: string,
    patch: Partial<WorkerConfig>,
  ): Observable<{ ok: boolean; config: WorkerConfig | null }> {
    return this.http.patch<{ ok: boolean; config: WorkerConfig | null }>(
      `${this.base}/workers/${encodeURIComponent(name)}/config`,
      patch,
    );
  }
}
