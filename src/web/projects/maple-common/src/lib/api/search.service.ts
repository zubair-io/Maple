// SearchService — wraps the auth-gated /api/search and /api/search/facets
// endpoints (Self-Hosted only). Mirror of the FilesystemBrowseService pattern:
// inject HttpClient + API_BASE_URL, return Observables, let the auth
// interceptor attach the bearer.

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';

export type SearchSort = 'captured_desc' | 'captured_asc' | 'name' | 'rating';
export type SearchFlag = 'pick' | 'reject' | 'none';
export type SearchColor = '' | 'red' | 'yellow' | 'green' | 'blue' | 'purple';
export type SearchSceneType = '' | 'indoor' | 'outdoor' | 'aerial' | 'macro' | 'studio' | 'mixed';

/** Query params for /api/search and /api/search/facets. All optional. */
export interface SearchParams {
  q?: string;
  libraryId?: string;
  camera?: string;
  lens?: string;
  isoMin?: number;
  isoMax?: number;
  apertureMin?: number;
  apertureMax?: number;
  focalMin?: number;
  focalMax?: number;
  /** ISO 8601 date string (captured_at >=). */
  from?: string;
  /** ISO 8601 date string (captured_at <=). */
  to?: string;
  /** Minimum star rating (>= n). */
  rating?: number;
  flag?: SearchFlag;
  color?: SearchColor;
  /** Comma-separated extension list, e.g. "dng,cr3". */
  ext?: string;
  /** 0-indexed page. */
  page?: number;
  /** Max 200, default 100. */
  limit?: number;
  sort?: SearchSort;
  /** Anchored prefix on `abs_path` (server escapes + applies as ^prefix). */
  pathPrefix?: string;
  /** When true, only matches assets with a non-null `exif.captured_at`. */
  hasCapturedAt?: boolean;
  /** Vision scene_type (closed union). */
  sceneType?: SearchSceneType;
  /** Vision activity (open vocab, exact match). */
  activity?: string;
  /** Multi-select subject tags. Sent as a comma-separated `subjects`
   * param — Mongo does OR within the field, AND against other filters. */
  subjects?: string[];
}

/** Single hit returned by /api/search. */
export interface SearchResult {
  /** "fs:" + abs_path — keys the editor cold-load + asset-grid the same way the
   * filesystem-browse path does. */
  id: string;
  _id: string;
  folder_id: string;
  abs_path: string;
  filename: string;
  size: number;
  mtime: number;
  captured_at: string | null;
  camera: { make: string | null; model: string | null } | null;
  lens: string | null;
  iso: number | null;
  aperture: number | null;
  shutter: string | null;
  focal_length: number | null;
  rating: number;
  flag: -1 | 0 | 1;
  color_label: string;
}

export interface SearchResponse {
  total: number;
  page: number;
  limit: number;
  results: SearchResult[];
}

export interface SearchFacets {
  total: number;
  cameras: Array<{ make: string | null; model: string | null; count: number }>;
  lenses: Array<{ value: string | null; count: number }>;
  extensions: Array<{ value: string; count: number }>;
  iso_range: { min: number; max: number } | null;
  capture_range: { from: string; to: string } | null;
  /** Counts per `vision.scene_type` value. Closed-union, so the FE renders
   * known options (indoor/outdoor/aerial/macro/studio/mixed); values not
   * present in this list have zero matches in the current filter scope. */
  scene_types: Array<{ value: string; count: number }>;
  /** Counts per `vision.activity` value (open vocab). */
  activities: Array<{ value: string; count: number }>;
  /** Counts per `vision.subjects` element (array field, unwound). */
  subjects: Array<{ value: string; count: number }>;
}

/** One year/month aggregation row from /api/search/buckets. */
export interface TimelineBucket {
  year: number;
  month: number;
  count: number;
}

/** Response shape from /api/search/buckets. */
export interface TimelineBuckets {
  total: number;
  buckets: TimelineBucket[];
  untimed_count: number;
}

/** Build HttpParams from a SearchParams object, skipping undefined / empty
 * values so the server sees exactly the params the user set. */
function paramsFrom(p: SearchParams): HttpParams {
  let h = new HttpParams();
  const set = (k: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (typeof v === 'string' && v.length === 0) return;
    h = h.set(k, String(v));
  };
  set('q', p.q);
  set('libraryId', p.libraryId);
  set('camera', p.camera);
  set('lens', p.lens);
  set('isoMin', p.isoMin);
  set('isoMax', p.isoMax);
  set('apertureMin', p.apertureMin);
  set('apertureMax', p.apertureMax);
  set('focalMin', p.focalMin);
  set('focalMax', p.focalMax);
  set('from', p.from);
  set('to', p.to);
  set('rating', p.rating);
  set('flag', p.flag);
  set('color', p.color);
  set('ext', p.ext);
  set('page', p.page);
  set('limit', p.limit);
  set('sort', p.sort);
  set('pathPrefix', p.pathPrefix);
  if (p.hasCapturedAt !== undefined) set('hasCapturedAt', p.hasCapturedAt ? 'true' : 'false');
  set('sceneType', p.sceneType);
  set('activity', p.activity);
  if (p.subjects && p.subjects.length > 0) {
    set('subjects', p.subjects.join(','));
  }
  return h;
}

@Injectable({ providedIn: 'root' })
export class SearchService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /** GET /api/search — paginated, sorted result list. */
  search(params: SearchParams): Observable<SearchResponse> {
    return this.http.get<SearchResponse>(`${this.base}/search`, {
      params: paramsFrom(params),
    });
  }

  /** GET /api/search/facets — counts/ranges scoped to the same filter set
   * (page/limit/sort are ignored server-side). */
  facets(params: Omit<SearchParams, 'page' | 'limit' | 'sort'>): Observable<SearchFacets> {
    return this.http.get<SearchFacets>(`${this.base}/search/facets`, {
      params: paramsFrom(params),
    });
  }

  /** GET /api/search/buckets — year/month aggregation over the same filter
   * set (page/limit/sort are ignored server-side). Used by the Timeline
   * view to pre-size the virtual scroller and render the right-rail
   * scrubber without fetching every photo first. */
  buckets(params: Omit<SearchParams, 'page' | 'limit' | 'sort'>): Observable<TimelineBuckets> {
    return this.http.get<TimelineBuckets>(`${this.base}/search/buckets`, {
      params: paramsFrom(params),
    });
  }
}
