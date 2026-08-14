// MapConfigService — typed HttpClient wrapper for /api/map/config (Map T2, #2826).
//
// Covers the operator-configurable tile-source setting for the web Map view
// (MapLibre GL). All methods return Observable<T> per project convention.

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';

export type MapConfigSource = 'db' | 'default';

export interface MapConfig {
  /** Style/tile URL the web map fetches base-map imagery from. Defaults to
   * a public OpenStreetMap raster source when unset. */
  tile_url: string;
  source: {
    tile_url: MapConfigSource;
  };
}

export interface MapConfigPatch {
  /** `null` clears a saved override, reverting to the default. */
  tile_url?: string | null;
}

@Injectable({ providedIn: 'root' })
export class MapConfigService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /** Read the effective tile-source config. */
  getConfig(): Observable<MapConfig> {
    return this.http.get<MapConfig>(`${this.base}/map/config`);
  }

  /** Upsert the operator's tile-source override. The observable errors with
   * a 400 (and a `{ error: string }` body) when the server rejects a
   * malformed URL. */
  putConfig(patch: MapConfigPatch): Observable<MapConfig & { ok: boolean }> {
    return this.http.put<MapConfig & { ok: boolean }>(`${this.base}/map/config`, patch);
  }
}
