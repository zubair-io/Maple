// BunApiBackend — HttpClient wrapper for the Maple Self Hosted API.
//
// Endpoints documented in src/api/README.md.
// All methods return Observable<T> per best-practices (no firstValueFrom).
//
// Base URL comes from API_BASE_URL (default '/api'), so deployments behind a
// reverse proxy work without rebuilding the bundle.

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
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
}
