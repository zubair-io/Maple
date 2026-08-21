// TrashApiService — thin HttpClient wrapper for the Trash pseudo-node
// (#2652). Mirrors `folder-crud.service.ts`'s shape (a plain, always-eager
// `HttpClient` service with no capability gating of its own — it's the
// callers, `TrashService` and the eager folder-tree row, that are gated
// behind `TRASH_CAPABILITY`).
//
//   GET  /api/folders/:id/trash          — paged list, newest-first
//   POST /api/assets/:id/restore         — single-asset restore
//   POST /api/folders/:id/restore-folder — recursive restore under a subtree
//   DELETE /api/assets/:id?intent=trash|purge — dual-mode on the server: a
//       live asset soft-deletes (send to Trash), an already-trashed asset
//       permanently purges. Both call sites in `TrashService` hit the exact
//       same endpoint with an explicit `intent` (#2749) pinning which
//       direction the caller means — the server 409s with `{ state }`
//       instead of silently running the OTHER branch when the caller's
//       listing turns out to be stale (a stale grid could otherwise
//       irreversibly purge a photo its user only meant to trash; a stale
//       Trash panel could otherwise quietly re-trash a photo someone had
//       already restored while reporting "cannot be undone"). One method
//       here (`deleteAsset`) serves both `trashAsset` and
//       `deletePermanently`, distinguished only by the `intent` argument —
//       never inferred from local state.
//
// There is no server-side "delete this folder's trash permanently in one
// call" endpoint — `routes/assets/trash.ts`'s module doc says as much
// ("The permanent-purge branch has no folder-level analogue"). Folder-level
// permanent delete in `TrashService` is a client-side loop over
// `deleteAsset` for each listed item, which is the same semantics the
// existing per-asset endpoint already gives — not a fabricated batch
// endpoint.

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, catchError, map, of, throwError } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';
import type { AssetId } from '../models/asset';
import type {
  RestoreAssetResult,
  TrashBatchSummary,
  TrashDeleteOutcome,
  TrashItem,
  TrashPage,
} from '../trash/trash.types';

/** Wire shape of one `GET /:id/trash` item — snake_case over the wire,
 * mapped to `TrashItem`'s camelCase in `listTrash`. */
interface TrashItemWire {
  asset_id: string;
  filename: string;
  original_relative_path: string;
  trash_relative_path: string;
  size: number;
  mtime: string;
  deleted_at: string;
  /** Absent on servers predating #2977 — mapped to 'user'. */
  reason?: 'user' | 'reaped';
}

interface TrashPageWire {
  items: TrashItemWire[];
  next_cursor: string | null;
}

interface RestoreAssetWire {
  asset_id: string;
  abs_path: string;
  filename: string;
  size: number;
  mtime: string;
}

function toTrashItem(wire: TrashItemWire): TrashItem {
  return {
    assetId: wire.asset_id,
    filename: wire.filename,
    originalRelativePath: wire.original_relative_path,
    trashRelativePath: wire.trash_relative_path,
    size: wire.size,
    mtime: wire.mtime,
    deletedAt: wire.deleted_at,
    reason: wire.reason ?? 'user',
  };
}

@Injectable({ providedIn: 'root' })
export class TrashApiService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /** One page of a library's trash, newest-first. `cursor` is the opaque
   * `nextCursor` from a prior page; omit for the first page. */
  listTrash(folderId: string, cursor?: string | null, limit = 100): Observable<TrashPage> {
    const params: Record<string, string> = cursor
      ? { limit: String(limit), cursor }
      : { limit: String(limit) };
    return this.http
      .get<TrashPageWire>(`${this.base}/folders/${folderId}/trash`, { params })
      .pipe(map((page) => ({ items: page.items.map(toTrashItem), nextCursor: page.next_cursor })));
  }

  /** Restore one trashed asset back to its recorded `original_path`.
   * `expectedFilename` is the name the caller displayed for this row
   * (`TrashItem.filename`) — compared against the server's response to
   * detect a collision-safe rename (`pickFreeRestoredPath`) rather than
   * silently reporting success either way. */
  restoreAsset(assetId: AssetId, expectedFilename: string): Observable<RestoreAssetResult> {
    return this.http
      .post<RestoreAssetWire>(`${this.base}/assets/${encodeURIComponent(assetId)}/restore`, {})
      .pipe(
        map((wire) => ({
          assetId: wire.asset_id,
          absPath: wire.abs_path,
          filename: wire.filename,
          size: wire.size,
          mtime: wire.mtime,
          renamedTo: wire.filename !== expectedFilename ? wire.filename : null,
        })),
      );
  }

  /** Recursively restore every trashed asset whose `original_path` was
   * under `targetRelPath` (empty string = the whole library root). */
  restoreFolder(folderId: string, targetRelPath: string): Observable<TrashBatchSummary> {
    return this.http.post<TrashBatchSummary>(
      `${this.base}/folders/${folderId}/restore-folder`,
      null,
      { headers: { 'X-Maple-Target-Path': encodeURIComponent(targetRelPath) } },
    );
  }

  /** `DELETE /api/assets/:id?intent=trash|purge` — soft-deletes a live
   * asset (`intent: 'trash'`) or permanently purges an already-trashed one
   * (`intent: 'purge'`). `intent` is REQUIRED here (unlike the server,
   * which still accepts an omitted `intent` for the legacy File Provider
   * contract — see file header) so no call site in this UI can silently
   * fall into the wrong branch by forgetting to pass it.
   *
   * `assetId` MUST be a real Mongo id — the server's `parseAssetId` does
   * `new ObjectId(id)` and 400s on anything else (#2841). The grid's
   * `Asset.id` is a `slug:relPath` address, not a Mongo id; resolving that
   * address is the caller's job (`TrashService.trashAssets` does it via
   * `BunApiBackendService.getAssetDetailsByAddress` before ever reaching
   * this method) — this service stays a thin, capability-agnostic HTTP
   * wrapper and doesn't resolve addresses itself. The id is URL-encoded
   * regardless, since a `slug:relPath` address slipping through unresolved
   * would otherwise also break route matching for any relPath containing a
   * `/`.
   *
   * A state-mismatch 409 (the caller's listing was stale — see file
   * header) resolves to `{ kind: 'conflict', state }` instead of throwing,
   * so every caller handles it as a first-class per-item outcome rather
   * than a generic HTTP failure. Any other error (network, 404, 500)
   * still propagates through the returned observable's error channel. */
  deleteAsset(assetId: AssetId, intent: 'trash' | 'purge'): Observable<TrashDeleteOutcome> {
    return this.http
      .delete<void>(`${this.base}/assets/${encodeURIComponent(assetId)}`, { params: { intent } })
      .pipe(
        map((): TrashDeleteOutcome => ({ kind: 'ok' })),
        catchError((err: unknown) => {
          if (err instanceof HttpErrorResponse && err.status === 409) {
            const state = (err.error as { state?: 'trashed' | 'live' } | null)?.state ?? null;
            return of<TrashDeleteOutcome>({ kind: 'conflict', state });
          }
          return throwError(() => err);
        }),
      );
  }
}
