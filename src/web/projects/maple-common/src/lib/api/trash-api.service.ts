// TrashApiService — thin HttpClient wrapper for the Trash pseudo-node
// (#2652). Mirrors `folder-crud.service.ts`'s shape (a plain, always-eager
// `HttpClient` service with no capability gating of its own — it's the
// callers, `TrashService` and the eager folder-tree row, that are gated
// behind `TRASH_CAPABILITY`).
//
//   GET  /api/folders/:id/trash          — paged list, newest-first
//   POST /api/assets/:id/restore         — single-asset restore
//   POST /api/folders/:id/restore-folder — recursive restore under a subtree
//   DELETE /api/assets/:id               — dual-mode on the server: a live
//       asset soft-deletes (send to Trash), an already-trashed asset
//       permanently purges. Both call sites in `TrashService` hit the exact
//       same endpoint — which branch runs is decided server-side by the
//       asset's current `deleted_at`, never by the client — so one method
//       here (`deleteAsset`) serves both `trashAsset` and
//       `deletePermanently`.
//
// There is no server-side "delete this folder's trash permanently in one
// call" endpoint — `routes/assets/trash.ts`'s module doc says as much
// ("The permanent-purge branch has no folder-level analogue"). Folder-level
// permanent delete in `TrashService` is a client-side loop over
// `deleteAsset` for each listed item, which is the same semantics the
// existing per-asset endpoint already gives — not a fabricated batch
// endpoint.

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';
import type { AssetId } from '../models/asset';
import type {
  RestoreAssetResult,
  TrashBatchSummary,
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
  };
}

@Injectable({ providedIn: 'root' })
export class TrashApiService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /** One page of a library's trash, newest-first. `cursor` is the opaque
   * `nextCursor` from a prior page; omit for the first page. */
  listTrash(folderId: string, cursor?: string | null, limit = 100): Observable<TrashPage> {
    let params: Record<string, string> = { limit: String(limit) };
    if (cursor) params = { ...params, cursor };
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
    return this.http.post<RestoreAssetWire>(`${this.base}/assets/${assetId}/restore`, {}).pipe(
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

  /** `DELETE /api/assets/:id` — soft-deletes a live asset (send to Trash)
   * or permanently purges an already-trashed one. See file header. */
  deleteAsset(assetId: AssetId): Observable<void> {
    return this.http.delete<void>(`${this.base}/assets/${assetId}`);
  }
}
