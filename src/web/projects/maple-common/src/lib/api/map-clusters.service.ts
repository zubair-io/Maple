// MapClustersService — typed HttpClient wrapper for `GET /api/map/clusters`
// (Map T4, #2828). One data source feeding both the clustered thumbnail
// pins/count bubbles built here and the heatmap layer #2829 adds later —
// see `map-cluster-source.ts` for the shared GeoJSON source both draw from.
//
// Design: docs/superpowers/specs/2026-08-14-photo-map-view-design.md
// § "1. Data endpoint". Server contract: src/api/src/routes/map/clusters.ts.

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';

/** Viewport bounds in decimal degrees — the same shape the map wrapper's
 * `getBounds()` returns, so callers never touch a MapLibre `LngLatBounds`
 * directly. */
export interface MapBoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** One grid cell from `/api/map/clusters` — mirrors `MapCluster` in
 * `src/api/src/routes/map/clusters.ts`. */
export interface MapCluster {
  lat: number;
  lng: number;
  count: number;
  representativeAssetId: string;
  placeLabel: string | null;
  /** The representative asset's absolute filesystem path. Present only
   * when `count === 1` — feed straight into
   * `FilesystemBrowseService.getThumbBlobUrl`, the same convention the
   * search grid already uses for abs-path-keyed thumbnails. */
  thumbKey?: string;
}

interface MapClustersResponse {
  cells: MapCluster[];
}

@Injectable({ providedIn: 'root' })
export class MapClustersService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /** GET /api/map/clusters?bbox=west,south,east,north&zoom=Z. `zoom` should
   * be an integer — the server clamps/validates it regardless, but sending
   * the map's fractional zoom would just make it re-derive the same integer
   * server-side for no benefit, so callers round before calling this. */
  getClusters(bbox: MapBoundingBox, zoom: number): Observable<MapCluster[]> {
    const params = new HttpParams()
      .set('bbox', `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`)
      .set('zoom', String(zoom));
    return this.http
      .get<MapClustersResponse>(`${this.base}/map/clusters`, { params })
      .pipe(map((response) => response.cells));
  }
}
