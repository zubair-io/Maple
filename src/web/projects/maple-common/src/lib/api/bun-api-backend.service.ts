// BunApiBackend — HttpClient wrapper for the Maple Self Hosted API.
//
// Endpoints documented in src/api/README.md.
// All methods return Observable<T> per best-practices (no firstValueFrom).
//
// Base URL comes from API_BASE_URL (default '/api'), so deployments behind a
// reverse proxy work without rebuilding the bundle.

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
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

export type IndexerStage = 'discover' | 'hash' | 'exif' | 'thumb' | 'ai' | 'mongo';

export interface IndexerStageCounters {
  inFlight: number;
  errors: number;
  deadLetter: number;
}

export interface IndexerChannelInfo {
  depth: number;
  capacity: number;
}

export interface IndexerStatus {
  paused: boolean;
  pools: Record<IndexerStage, number>;
  channels: Record<IndexerStage, IndexerChannelInfo>;
  stages: Record<IndexerStage, IndexerStageCounters>;
  /** Files currently being processed per stage (capped). Empty when idle. */
  inFlightPaths?: Record<IndexerStage, string[]>;
  /** Cumulative count of jobs completed (success+fail) per stage since the
   * server started. Resets on process restart — not persisted. */
  processed?: Record<IndexerStage, number>;
  /** Number of folders currently being watched. */
  folders?: number;
  /** Whether the indexer service has started. */
  started?: boolean;
  /** EXIF backfill (one-shot upgrade for pre-EXIF rows). */
  exifBackfill?: IndexerExifBackfillStatus;
}

export interface IndexerExifBackfillStatus {
  /** True while a backfill run is in flight. */
  running: boolean;
  /** Rows processed so far in the current/last run. */
  scanned: number;
  /** Rows successfully upgraded so far in the current/last run. */
  upgraded: number;
  /** Estimated rows still missing exif at the start of the run. -1 = unknown. */
  pending: number;
  /** ISO timestamp the most recent run finished, or null if never run. */
  lastFinishedAt: string | null;
  /** Error from the most recent run, or null if it succeeded. */
  lastError: string | null;
}

export interface IndexerDeadLetterItem {
  id?: string;
  stage: string;
  jobId?: string;
  absPath?: string;
  error?: string;
  attempts?: number;
  failedAt?: string;
}

export interface IndexerDeadLetterPage {
  items: IndexerDeadLetterItem[];
  total: number;
  warning?: string;
}

/**
 * Supervisor view of the standalone indexer child process. Mirrors
 * `IndexerProcessState` from `src/api/src/indexer/control.ts`.
 */
export interface IndexerProcessState {
  status: 'stopped' | 'starting' | 'running' | 'crashed' | 'restarting';
  pid: number | null;
  lastStartedAt: string | null;
  lastExitCode: number | null;
  lastError: string | null;
  restartCount: number;
}

export interface IndexerLifecycleResponse {
  ok: boolean;
  state: IndexerProcessState;
  error?: string;
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

  getIndexerStatus(): Observable<IndexerStatus> {
    return this.http.get<IndexerStatus>(`${this.base}/indexer/status`);
  }

  setIndexerWorkers(workers: Partial<Record<IndexerStage, number>>): Observable<{ ok: boolean; status: IndexerStatus }> {
    return this.http.put<{ ok: boolean; status: IndexerStatus }>(
      `${this.base}/indexer/config`,
      { workers },
    );
  }

  pauseIndexer(): Observable<{ ok: boolean; status: IndexerStatus }> {
    return this.http.post<{ ok: boolean; status: IndexerStatus }>(`${this.base}/indexer/pause`, {});
  }

  resumeIndexer(): Observable<{ ok: boolean; status: IndexerStatus }> {
    return this.http.post<{ ok: boolean; status: IndexerStatus }>(`${this.base}/indexer/resume`, {});
  }

  /** Trigger an EXIF backfill run. Server returns immediately; progress
   * is exposed via subsequent `getIndexerStatus().exifBackfill`. */
  runExifBackfill(limit?: number): Observable<{ ok: boolean; status: IndexerStatus }> {
    const params = limit !== undefined ? new HttpParams().set('limit', String(limit)) : undefined;
    return this.http.post<{ ok: boolean; status: IndexerStatus }>(
      `${this.base}/indexer/exif-backfill`,
      {},
      { params },
    );
  }

  listDeadLetter(limit = 200): Observable<IndexerDeadLetterPage> {
    const params = new HttpParams().set('limit', String(limit));
    return this.http.get<IndexerDeadLetterPage>(`${this.base}/indexer/dead-letter`, { params });
  }

  /** Read the supervisor's view of the indexer child process. */
  getIndexerProcess(): Observable<IndexerProcessState> {
    return this.http.get<IndexerProcessState>(`${this.base}/indexer/process`);
  }

  /** Spawn (or re-spawn) the standalone indexer child and wait for it to
   * report ready. Returns the supervisor state on completion. */
  startIndexer(): Observable<IndexerLifecycleResponse> {
    return this.http.post<IndexerLifecycleResponse>(`${this.base}/indexer/start`, {});
  }

  /** SIGTERM the indexer child (forced kill on grace timeout). */
  stopIndexer(): Observable<IndexerLifecycleResponse> {
    return this.http.post<IndexerLifecycleResponse>(`${this.base}/indexer/stop`, {});
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
   * supplied — a 502 means the URL is wrong and nothing was saved. */
  saveEnrichmentConfig(
    body: { nominatim_url: string | null; geocode_worker_enabled: boolean },
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
}

export interface EnrichmentConfigResponse {
  nominatim_url: string | null;
  geocode_worker_enabled: boolean;
  source: {
    nominatim_url: 'db' | 'env' | 'unset';
    geocode_worker_enabled: 'db' | 'env' | 'default';
  };
}

export interface EnrichmentTestResponse {
  ok: boolean;
  url?: string;
  error?: string;
  status?: number | null;
}
