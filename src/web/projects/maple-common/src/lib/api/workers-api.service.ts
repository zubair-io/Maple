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
  /** Total docs this stage still owes work on (version < target, not dead). */
  pending: number;
  /** Subset of `pending` whose upstream deps are met — claimable right now. */
  ready: number;
  /** Subset of `pending` waiting on an upstream stage (= pending − ready). */
  blocked: number;
  /** Dead-lettered doc count. */
  dead: number;
  /** Docs completed per minute, rolling window. */
  throughput: number;
  lastError: string | null;
  /** Persisted operator config for this stage. Null when not yet seeded. */
  config: WorkerConfig | null;
  /** Claim batch limit, derived server-side as 5×concurrency (#674). */
  batchSize: number;
}

export interface WorkersStatusResponse {
  stages: StageStatus[];
  /** Collection-level count of assets tagged `damaged` (unreadable bytes,
   * parked out of every stage). Optional so a stale frame without it reads as
   * 0 rather than NaN. */
  damaged?: number;
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

/** One row in the damaged-files list — returned by GET /api/workers/damaged. */
export interface DamagedDoc {
  /** Asset `_id` (hex) — the queryable handle into the assets collection. */
  id: string;
  /** Content hash; the stable id an operator greps for. Null on rows that
   * never reached the exif stage that upgrades the id. */
  maple_id: string | null;
  abs_path: string | null;
  /** Stage that exhausted retries and tagged the file. */
  stage: string | null;
  /** Last error message that made the file unreadable. */
  reason: string | null;
  /** ISO 8601 timestamp the file was first tagged damaged. */
  since: string | null;
}

export interface DamagedListResponse {
  items: DamagedDoc[];
}

/** Live FFI decode-pool snapshot (GET /api/workers/performance). */
export interface FfiPoolStats {
  /** Configured target pool size. */
  target: number;
  /** Workers actually spawned (lazy — ≤ target). */
  spawned: number;
  /** Workers with an in-flight decode. */
  busy: number;
  /** Requests waiting for a free worker. */
  queued: number;
}

/** Effective performance config + clamp bounds + live pool state. */
export interface PerformanceConfig {
  /** Effective RAW decode-worker count, clamped to [min, max]. */
  ffi_workers: number;
  /** Where the effective value came from. */
  source: 'db' | 'env' | 'default';
  /** Hard clamp lower bound (1). */
  min: number;
  /** Hard clamp upper bound (16). */
  max: number;
  pool: FfiPoolStats;
}

/** Response to PATCH /api/workers/performance. */
export interface PatchPerformanceResponse {
  ok: boolean;
  ffi_workers: number;
  source: 'db' | 'env' | 'default';
  pool: FfiPoolStats;
}

/** One registered migration (GET /api/workers/migration/migrations). */
export interface MigrationInfo {
  id: string;
  title: string;
  description: string;
  /** Operator toggle — a migration only runs while enabled. */
  enabled: boolean;
  status: 'idle' | 'running' | 'done' | 'error';
  /** Items moved/deduped since last enabled. */
  processed: number;
  errors: number;
  /** Items still needing transformation. */
  remaining: number;
  /** Live count of items parked in this migration's own dead-letter queue
   * (distinct from the cumulative `errors` counter, which never decreases).
   * Only present for migrations that track one — e.g. the Meilisearch
   * backfill's redrivable `meilisearch_backfill_failures` collection. */
  failedPermanently?: number;
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface MigrationsResponse {
  migrations: MigrationInfo[];
}

/** Persisted per-migration state echoed back by PATCH. */
export interface MigrationState {
  enabled: boolean;
  status: 'idle' | 'running' | 'done' | 'error';
  processed: number;
  errors: number;
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
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

  /** List assets tagged `damaged` (unreadable bytes, parked out of every
   * stage). Collection-level — not per-stage. */
  listDamaged(limit = 200): Observable<DamagedListResponse> {
    return this.http.get<DamagedListResponse>(`${this.base}/workers/damaged?limit=${limit}`);
  }

  /** Clear the `damaged` tag and re-queue. Pass an asset id to clear one;
   * omit it to clear every damaged asset. */
  clearDamaged(id?: string): Observable<{ ok: boolean; cleared: number }> {
    return this.http.post<{ ok: boolean; cleared: number }>(
      `${this.base}/workers/damaged/clear`,
      id ? { id } : {},
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

  /** Read the missing-reaper prune window (hours an original must be missing
   * before its row is hard-deleted). */
  getReaperPruneWindow(): Observable<{ hours: number }> {
    return this.http.get<{ hours: number }>(`${this.base}/workers/missing-reaper/prune-window`);
  }

  /** Update the missing-reaper prune window. Takes effect on the reaper's next
   * tick (no restart). */
  setReaperPruneWindow(hours: number): Observable<{ ok: boolean; hours: number }> {
    return this.http.patch<{ ok: boolean; hours: number }>(
      `${this.base}/workers/missing-reaper/prune-window`,
      { hours },
    );
  }

  /** Read the effective FFI decode-pool size + live pool stats. */
  getPerformanceConfig(): Observable<PerformanceConfig> {
    return this.http.get<PerformanceConfig>(`${this.base}/workers/performance`);
  }

  /** Set the RAW decode-worker count. The server clamps to [1, 16], persists
   * to the `performance` settings doc, and resizes the live pool immediately. */
  patchPerformanceConfig(ffiWorkers: number): Observable<PatchPerformanceResponse> {
    return this.http.patch<PatchPerformanceResponse>(`${this.base}/workers/performance`, {
      ffi_workers: ffiWorkers,
    });
  }

  /** List the registered one-shot migrations with their state + remaining work. */
  listMigrations(): Observable<MigrationsResponse> {
    return this.http.get<MigrationsResponse>(`${this.base}/workers/migration/migrations`);
  }

  /** Toggle a migration on/off. Enabling arms a fresh run; the worker picks it
   * up on its next tick (no restart). */
  setMigrationEnabled(
    id: string,
    enabled: boolean,
  ): Observable<{ ok: boolean; state: MigrationState }> {
    return this.http.patch<{ ok: boolean; state: MigrationState }>(
      `${this.base}/workers/migration/migrations/${encodeURIComponent(id)}`,
      { enabled },
    );
  }

  /** Reset a migration's progress back to idle/disabled. */
  resetMigration(id: string): Observable<{ ok: boolean; state: MigrationState }> {
    return this.http.patch<{ ok: boolean; state: MigrationState }>(
      `${this.base}/workers/migration/migrations/${encodeURIComponent(id)}`,
      { reset: true },
    );
  }
}
