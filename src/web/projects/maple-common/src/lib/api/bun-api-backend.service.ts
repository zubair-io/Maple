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
  name: string;
  assetCount: number;
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

  listDeadLetter(limit = 200): Observable<IndexerDeadLetterPage> {
    const params = new HttpParams().set('limit', String(limit));
    return this.http.get<IndexerDeadLetterPage>(`${this.base}/indexer/dead-letter`, { params });
  }
}
