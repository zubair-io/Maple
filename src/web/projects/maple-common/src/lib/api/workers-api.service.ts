// WorkersApiService — typed HttpClient wrapper for /api/workers/*.
//
// All methods return Observable<T> per project convention.
// Consumed by WorkersComponent (polling) and WorkerConfigDialogComponent (PATCH).

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';

export interface WorkerConfig {
  concurrency: number;
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
}

export interface StageState {
  name: string;
  status: 'running' | 'paused' | 'error';
  workers: { active: number; configured: number };
  in_flight: { dispatched: number; batch_size: number };
  pending: number;
  dead: number;
  throughput_per_minute: number;
  last_error: string | null;
}

export interface WorkersStatusResponse {
  stages: StageState[];
}

@Injectable({ providedIn: 'root' })
export class WorkersApiService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  getStatus(): Observable<WorkersStatusResponse> {
    return this.http.get<WorkersStatusResponse>(`${this.base}/workers/status`);
  }

  pause(name: string): Observable<void> {
    return this.http.post<void>(`${this.base}/workers/${encodeURIComponent(name)}/pause`, null);
  }

  resume(name: string): Observable<void> {
    return this.http.post<void>(`${this.base}/workers/${encodeURIComponent(name)}/resume`, null);
  }

  retryDead(name: string): Observable<{ reset: number }> {
    return this.http.post<{ reset: number }>(
      `${this.base}/workers/${encodeURIComponent(name)}/retry-dead`,
      null,
    );
  }

  patchConfig(
    name: string,
    patch: Partial<WorkerConfig>,
  ): Observable<{ config: WorkerConfig }> {
    return this.http.patch<{ config: WorkerConfig }>(
      `${this.base}/workers/${encodeURIComponent(name)}/config`,
      patch,
    );
  }
}
