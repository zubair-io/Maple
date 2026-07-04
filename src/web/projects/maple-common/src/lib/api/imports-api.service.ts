// ImportsApiService — typed HttpClient wrapper for /api/imports/* (ticket
// #742). Copies a server-local folder into a registered Library, laid out as
// <LibRoot>/<YEAR>/<MM-or-label>/<filename>.
//
// All methods return Observable<T> per project convention. The auth
// interceptor attaches the bearer; the server gates every route behind
// requireAuth and jails the source folder to MAPLE_ROOTS.

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';

/** One YEAR/MM group from POST /api/imports/scan. */
export interface ImportScanBucket {
  /** Stable `${year}/${mm}` key — the label-override map is keyed on this. */
  key: string;
  year: string;
  /** Two-digit month; also the default bucket label. */
  mm: string;
  fileCount: number;
  imageCount: number;
  movieCount: number;
  sidecarCount: number;
  totalBytes: number;
  /** Where files in this bucket land if the label is left blank. */
  defaultDest: string;
  /** Number of files that would instead land next to an already-indexed
   * photo captured within 30 minutes of them (0 if no library was given to
   * `scan()`, or nothing matched). */
  nearbyMatchCount: number;
  /** Distinct folders those nearby-matched files would land in. */
  nearbyMatchFolders: string[];
}

export interface ImportScanResult {
  source_root: string;
  buckets: ImportScanBucket[];
  totals: {
    files: number;
    images: number;
    movies: number;
    sidecars: number;
    bytes: number;
  };
}

export type ImportStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export type ImportFileState = 'pending' | 'copied' | 'skipped_duplicate' | 'failed';

export interface ImportFileEntry {
  src: string;
  dest: string;
  size: number;
  mtime: number;
  kind: 'image' | 'sidecar' | 'movie';
  state: ImportFileState;
  error: string | null;
}

/** List + progress-poll shape: everything except the per-file `files` array
 * (the only field that grows with file count). */
export interface ImportSummary {
  id: string;
  status: ImportStatus;
  source_root: string;
  library_id: string;
  library_root: string;
  /** Auto Import awaiting the worker's deferred scan. */
  scan_pending: boolean;
  progress: { current: number; total: number };
  counts: { copied: number; skipped: number; failed: number };
  error: string | null;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
}

/** Full detail shape — adds the per-file `files` array to the summary. */
export interface ImportView extends ImportSummary {
  files: ImportFileEntry[];
}

export interface CreateImportBody {
  source_root: string;
  library_id: string;
  /** Per-bucket label overrides, keyed on the `${year}/${mm}` bucket key. */
  labels?: Record<string, string>;
  /** Auto Import — queue immediately and let the worker scan + resolve files
   * (default `MM` labels). When set, `labels` is ignored. */
  auto?: boolean;
}

@Injectable({ providedIn: 'root' })
export class ImportsApiService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /** POST /api/imports/scan — scan a server-local folder into buckets.
   * `libraryId` is optional but should be passed whenever known (the target
   * library is always chosen before the source folder in the UI flow) so
   * the preview can also resolve nearby-asset matches against it. */
  scan(sourceRoot: string, libraryId?: string): Observable<ImportScanResult> {
    return this.http.post<ImportScanResult>(`${this.base}/imports/scan`, {
      source_root: sourceRoot,
      library_id: libraryId,
    });
  }

  /** POST /api/imports — create a pending import, returns `{ id }`. */
  create(body: CreateImportBody): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`${this.base}/imports`, body);
  }

  /** GET /api/imports — list imports (newest first). Summaries only. */
  list(status?: ImportStatus, limit?: number): Observable<{ imports: ImportSummary[] }> {
    let params = new HttpParams();
    if (status) params = params.set('status', status);
    if (limit !== undefined) params = params.set('limit', String(limit));
    return this.http.get<{ imports: ImportSummary[] }>(`${this.base}/imports`, {
      params,
    });
  }

  /** GET /api/imports/:id — full import doc with per-file progress. */
  get(id: string): Observable<ImportView> {
    return this.http.get<ImportView>(`${this.base}/imports/${id}`);
  }

  /** GET /api/imports/:id?summary=1 — lightweight status/progress for polling
   * (no per-file `files` array, so a large import doesn't re-transfer MBs). */
  poll(id: string): Observable<ImportSummary> {
    return this.http.get<ImportSummary>(`${this.base}/imports/${id}`, {
      params: new HttpParams().set('summary', '1'),
    });
  }

  /** POST /api/imports/:id/cancel — request cancel (between-files). */
  cancel(id: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/imports/${id}/cancel`, {});
  }

  /** POST /api/imports/:id/retry — re-queue a failed / partially-failed import
   * (resets its failed files to pending; already-copied files stay copied). */
  retry(id: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/imports/${id}/retry`, {});
  }
}
