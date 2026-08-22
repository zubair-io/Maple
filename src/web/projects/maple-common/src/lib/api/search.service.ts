// SearchService — wraps the auth-gated /api/search and /api/search/facets
// endpoints (Self-Hosted only). Mirror of the FilesystemBrowseService pattern:
// inject HttpClient + API_BASE_URL, return Observables, let the auth
// interceptor attach the bearer.

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';
import type { ColorLabelValue } from '../models/color-label';

export type SearchSort = 'captured_desc' | 'captured_asc' | 'name' | 'rating';
export type SearchFlag = 'pick' | 'reject' | 'none';
export type SearchColor = '' | ColorLabelValue;
export type SearchSceneType = '' | 'indoor' | 'outdoor' | 'aerial' | 'macro' | 'studio' | 'mixed';
/** Server-side scope from the S7 search chips. `photos` is the default
 * (full live set); `places`/`people` narrow by underlying field presence;
 * `albums` is recognised but the backend has no album field today and
 * returns `{ results: [], notImplemented: true }`. */
export type SearchScopeParam = 'photos' | 'places' | 'people' | 'albums';

/** Capture-date window the server reports as applied. */
export interface AppliedDateFilter {
  from?: string;
  to?: string;
  /** The search text the window was derived from; absent when explicit. */
  inferredFrom?: string;
}

/** Query params for /api/search and /api/search/facets. All optional. */
export interface SearchParams {
  /** Filename/path substring match (case-insensitive regex on
   * `fileinfo[].filename` / `fileinfo[].path`). */
  q?: string;
  /** Free-text content search against the unified `search_blob` (place +
   * caption + OCR + people). Natural-language dates ("May 2023") and
   * person-name matching work with or without Meilisearch: NL dates are
   * parsed into `from`/`to` before the backend picks an engine, and people
   * are folded into `search_blob`, which the Mongo `$text` fallback also
   * matches. When Meilisearch is configured it adds typo-tolerance and
   * semantic (vector) ranking on top. This is what the main search box
   * drives. */
  placeQuery?: string;
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
  /** 0-indexed page. Ignored when `cursor` is set. */
  page?: number;
  /**
   * Opaque seek cursor from a previous response's `nextCursor` (#2129).
   * Replaces `page` entirely: the server resumes with a range predicate on
   * `(exif.captured_at, _id)` instead of a SKIP, so deep pages stop costing
   * more than shallow ones.
   *
   * Only the `captured_desc` / `captured_asc` sorts mint one, and never on
   * the `placeQuery` text path (its ordering is a computed relevance score,
   * which isn't a stored field and so can't be seeked). Callers must treat
   * `nextCursor: null` as "keep using `page`" rather than "no more rows" —
   * see `SearchResponse.nextCursor`. Sending a cursor the server didn't
   * mint for this sort is a 400, deliberately: silently ignoring it would
   * restart the scroll at page 0 and duplicate everything already shown.
   */
  cursor?: string;
  /** Max 200, default 100. */
  limit?: number;
  sort?: SearchSort;
  /** Anchored prefix on `abs_path` (server escapes + applies as ^prefix). */
  pathPrefix?: string;
  /** When true, only matches assets with a non-null `exif.captured_at`. */
  hasCapturedAt?: boolean;
  /** Vision scene_type (closed union). */
  sceneType?: SearchSceneType;
  /** Recurring month-of-year (1–12) on `exif.captured_month` — matches that
   * month in EVERY year; composes with `from`/`to` rather than replacing
   * them (#2715). */
  month?: number;
  /** Vision activity (open vocab, exact match). */
  activity?: string;
  /** Multi-select subject tags. Sent as a comma-separated `subjects`
   * param — Mongo does OR within the field, AND against other filters. */
  subjects?: string[];
  /** Tri-state screenshot filter: `true` → screenshots only, `false` →
   * photographs only, `undefined` → both. */
  isScreenshot?: boolean;
  /** Selected person display names — the unified People filter picker
   * (#2864/#2865). Sent as a comma-separated `people` param; the server
   * resolves names to person ids and matches `faces.person_id`. OR within
   * the field, AND against other filters. */
  people?: string[];
  /** Selected place labels straight from the facets `places` bucket
   * (#2864/#2865). Sent as a `|`-separated `place` param — the labels
   * themselves contain commas ("Portland, OR"). OR within the field. */
  place?: string[];
  /** S7 search chip scope. See `SearchScopeParam`. */
  scope?: SearchScopeParam;
  /** Hidden image filter option. */
  hidden?: 'all' | 'only';
}

/** Single hit returned by /api/search. */
export interface SearchResult {
  /** "fs:" + abs_path — keys the editor cold-load + asset-grid the same way the
   * filesystem-browse path does. */
  id: string;
  /** `slug:relPath` address — the only address form the batch-metadata
   * endpoints (`fetchSnapshots`, `batchApply`) accept. `null` when the
   * asset's primary library has no registered slug. */
  address: string | null;
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
  /** True iff the XMP write/delete handlers have observed a sidecar
   * next to this asset. Drives the S2 Library Grid "Edited" filter
   * chip (#628). Missing on legacy docs — readers coerce to `false`. */
  has_xmp?: boolean;
  hidden?: boolean;
}

export interface SearchResponse {
  total: number;
  page: number;
  limit: number;
  results: SearchResult[];
  /**
   * Whether this query supports seek pagination (#2129) — true for the
   * `captured_desc` / `captured_asc` sorts off the relevance-ranked
   * `placeQuery` path, false everywhere else. Absent on responses from a
   * server predating the field; readers coerce to `false`.
   *
   * This is what disambiguates `nextCursor: null`. With `cursorPaging`
   * true it means the seek chain is **exhausted** and the caller must
   * stop; with it false it means seek pagination was never available and
   * the caller keeps using `page`. Without the distinction, a stale
   * `total` (it is cached server-side for 30 s) leaves `canLoadMore` true
   * at the end of the chain and the grid falls back to deep `page + 1`
   * SKIP paging — exactly the cost cursors exist to remove.
   */
  cursorPaging?: boolean;
  /**
   * Seek cursor for the next page, or `null` when there is none. See
   * `cursorPaging` for what `null` means in each mode.
   */
  nextCursor?: string | null;
  /** Set to `true` by the backend when the requested `scope` has no
   * underlying field today (currently only `albums`). The grid is empty
   * by definition; UIs surface "Coming soon" instead of "No matches". */
  notImplemented?: boolean;

  /**
   * The capture-date window actually applied, when there is one. Present with
   * `inferredFrom` when the server derived it from the query text rather than
   * from an explicit `from`/`to` — the case the UI has to attribute, because
   * the user never chose it and nothing in the panel reflects it (#2956).
   */
  dateFilter?: AppliedDateFilter;
}

/**
 * True when a seek-paginated result set has been walked to its end (#2129).
 *
 * `nextCursor: null` alone is ambiguous — it also covers "this query was
 * never seekable" — so the check needs `cursorPaging` too. Callers use it to
 * clamp `total` to the rows they hold: the server-side `total` is cached for
 * 30 s and can overstate the set, and trusting a stale one at the end of the
 * chain leaves the infinite-scroll gate open, sending the grid back to deep
 * `page + 1` SKIP paging — the exact cost cursors exist to remove.
 */
export function seekExhausted(r: SearchResponse): boolean {
  return r.cursorPaging === true && (r.nextCursor ?? null) === null;
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
  /** Tri-state screenshot bucket counts. `unknown` covers legacy rows
   * indexed before #175 where the field wasn't written. */
  is_screenshot: { true: number; false: number; unknown: number };
  /** Per-person asset counts for the unified People picker (#2864) —
   * named, non-hidden persons, filter-aware, descending. Absent on
   * servers predating the field; readers coerce to `[]`. */
  people?: Array<{ value: string; count: number }>;
  /** Per-place asset counts for the unified Places picker (#2864). The
   * `value` labels feed the `place` filter param verbatim. Absent on
   * servers predating the field; readers coerce to `[]`. */
  places?: Array<{ value: string; count: number }>;
}

/** `undefined` stays undefined (omitted); booleans stringify for the wire. */
function boolStr(v: boolean | undefined): string | undefined {
  if (v === undefined) return undefined;
  return v ? 'true' : 'false';
}

/** Join a multi-value param, or omit it when empty/absent. */
function joined(v: readonly string[] | undefined, sep: string): string | undefined {
  return v !== undefined && v.length > 0 ? v.join(sep) : undefined;
}

/** Build HttpParams from a SearchParams object, skipping undefined / null /
 * empty-string values so the server sees exactly the params the user set.
 * Table-driven — every entry is pre-serialised, so adding a param is one
 * row, not another branch. */
function paramsFrom(p: SearchParams): HttpParams {
  const entries: ReadonlyArray<[string, string | number | undefined | null]> = [
    ['q', p.q],
    ['placeQuery', p.placeQuery],
    ['libraryId', p.libraryId],
    ['camera', p.camera],
    ['lens', p.lens],
    ['isoMin', p.isoMin],
    ['isoMax', p.isoMax],
    ['apertureMin', p.apertureMin],
    ['apertureMax', p.apertureMax],
    ['focalMin', p.focalMin],
    ['focalMax', p.focalMax],
    ['from', p.from],
    ['to', p.to],
    ['rating', p.rating],
    ['flag', p.flag],
    ['color', p.color],
    ['ext', p.ext],
    // A cursor supersedes `page` — send one or the other, never both, so a
    // stale page counter left on the caller's params can't shadow the seek.
    p.cursor !== undefined && p.cursor !== '' ? ['cursor', p.cursor] : ['page', p.page],
    ['limit', p.limit],
    ['sort', p.sort],
    ['pathPrefix', p.pathPrefix],
    ['hasCapturedAt', boolStr(p.hasCapturedAt)],
    ['sceneType', p.sceneType],
    ['month', p.month !== undefined ? String(p.month) : undefined],
    ['activity', p.activity],
    ['subjects', joined(p.subjects, ',')],
    ['isScreenshot', boolStr(p.isScreenshot)],
    ['people', joined(p.people, ',')],
    // `|`-separated — place labels contain commas, so commas can't separate.
    ['place', joined(p.place, '|')],
    ['scope', p.scope],
    ['hidden', p.hidden],
  ];
  return entries.reduce(
    (h, [k, v]) => (v === undefined || v === null || v === '' ? h : h.set(k, String(v))),
    new HttpParams(),
  );
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

  // Note: this client does not wrap GET /api/search/buckets. The web
  // Timeline view fetches a single sorted /api/search query and buckets
  // client-side instead (see timeline-view.utils.ts); the route itself is
  // untouched and still serves Apple's Maple Cloud sync feature
  // (CloudTimelineViewModel), which calls it directly over HTTP rather
  // than through this TypeScript client.
}
