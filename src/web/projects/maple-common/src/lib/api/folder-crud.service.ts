// FolderCrudService — thin HttpClient wrapper for the folder-tree CRUD
// endpoints on `routes/folders.ts` (#2643).
//
// All three routes share the same header convention: paths are relative to
// the library root (the `:id` in the URL), URL-encoded as a single string
// and decoded server-side with `decodeURIComponent` — see
// `validateRelPathHeader` in `src/api/src/routes/folders.ts`. That decode
// happens on the whole header value at once (not per path segment), so a
// plain `encodeURIComponent` of the full relative path round-trips through
// it correctly, `/` included.
//
//   POST /:id/mkdir         — X-Maple-Target-Path              (new folder)
//   POST /:id/move          — X-Maple-Source-Path + X-Maple-Target-Path (rename)
//   POST /:id/trash-folder  — X-Maple-Target-Path              (recursive trash)
//
// `trash-folder` is documented in the file-management design doc's "Folder
// tree CRUD" section but ships on `PR #2695` (#2630), not yet merged to
// `main` as of #2643. Calling it against a server that hasn't picked up
// #2695 yet 404s — `HttpClient` surfaces that as an `HttpErrorResponse`
// like any other failure, so the caller's existing error handling covers it
// with no special-casing here.

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, catchError, map, of, throwError } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';

export interface FolderMoveResult {
  abs_path: string;
}

/** `move()`'s per-call outcome. A 409 means `/:id/move`'s own "refuse to
 * clobber an existing destination" check rejected the rename — the target
 * name is already taken in this folder, not a network/server failure — so
 * it resolves to `{ kind: 'collision' }` instead of throwing, the same
 * "expected outcome, not a generic HTTP failure" contract
 * `TrashApiService.deleteAsset`'s 409 handling already uses. Any other
 * error (network, 404, 500) still propagates through the observable's
 * error channel. */
export type FolderMoveOutcome = { kind: 'ok'; result: FolderMoveResult } | { kind: 'collision' };

/** One asset's outcome within a recursive folder trash batch. */
export interface FolderTrashBatchItem {
  assetId: string;
  filename: string;
  ok: boolean;
  error?: string;
}

/** Mirrors the server's `FolderBatchSummary` (`library/folder-trash.ts`,
 * PR #2695) — a partial-failure batch summary, not a single pass/fail. */
export interface FolderTrashSummary {
  total: number;
  succeeded: number;
  failed: number;
  items: FolderTrashBatchItem[];
}

@Injectable({ providedIn: 'root' })
export class FolderCrudService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /** Create `targetRelPath` (relative to the library root) — idempotent,
   * `mkdir -p` semantics: the server (`routes/folders.ts`'s `/:id/mkdir`)
   * never 409s on an existing directory, it just succeeds again (verified
   * by `folders.mkdir.test.ts`'s "is idempotent when the directory already
   * exists" case) — so there's no collision outcome to type here the way
   * `move()` below has. A target that exists as a non-directory still
   * surfaces as a generic 500 through the plain error channel. */
  mkdir(folderId: string, targetRelPath: string): Observable<FolderMoveResult> {
    return this.http.post<FolderMoveResult>(`${this.base}/folders/${folderId}/mkdir`, null, {
      headers: { 'X-Maple-Target-Path': encodeURIComponent(targetRelPath) },
    });
  }

  /** Rename or move `sourceRelPath` to `targetRelPath`, both relative to the
   * library root. Used for inline rename (same parent, new name) — a real
   * cross-folder move is out of this ticket's scope (#2644). */
  move(
    folderId: string,
    sourceRelPath: string,
    targetRelPath: string,
  ): Observable<FolderMoveOutcome> {
    return this.http
      .post<FolderMoveResult>(`${this.base}/folders/${folderId}/move`, null, {
        headers: {
          'X-Maple-Source-Path': encodeURIComponent(sourceRelPath),
          'X-Maple-Target-Path': encodeURIComponent(targetRelPath),
        },
      })
      .pipe(
        map((result): FolderMoveOutcome => ({ kind: 'ok', result })),
        catchError((err: unknown) => {
          if (err instanceof HttpErrorResponse && err.status === 409) {
            return of<FolderMoveOutcome>({ kind: 'collision' });
          }
          return throwError(() => err);
        }),
      );
  }

  /** Recursively trash every live asset under `targetRelPath`. Depends on
   * PR #2695 (#2630) landing on the server — see file header. */
  trashFolder(folderId: string, targetRelPath: string): Observable<FolderTrashSummary> {
    return this.http.post<FolderTrashSummary>(
      `${this.base}/folders/${folderId}/trash-folder`,
      null,
      { headers: { 'X-Maple-Target-Path': encodeURIComponent(targetRelPath) } },
    );
  }
}
