// DragMoveService — drag-to-folder-tree move/copy orchestration (#2644).
//
// Runs the relocate queue for one drop sequentially, one asset at a time:
// each `POST /api/assets/:id/relocate` call either lands, gets silently
// skipped ("already at destination"), or collides — a collision pauses the
// queue and surfaces `collisionPrompt` so the caller renders Skip / Replace
// / Keep Both, matching the design doc's "collisions ask, because a user is
// watching" (unlike background workers, which auto-suffix). Non-collision
// failures (network error, server 500) are recorded and the queue moves on
// — batch operations report partial failure, they don't roll back assets
// that already succeeded (same contract `library/relocate-asset.ts` and the
// batch-metadata editor already use).
//
// Deliberately does NOT optimistically patch `LibraryStateService`'s asset
// list mid-queue. Once the whole queue settles, `_finish` calls
// `LibraryStateService.refreshFolderListing` for the source AND destination
// folders — a real re-pull from the server — rather than hand-rolling the
// id/path rewrite for however many of N assets actually made it, per the
// design doc's explicit "refresh, don't mutate" guidance for this feature.
//
// NOT injected directly by `asset-grid`/`folder-tree` — see
// `drag-move-capability.ts`'s module doc for why they depend on
// `DragMoveCapability`/`DRAG_MOVE_CAPABILITY` instead, and why importing
// this class only from `provideSelfHostedWorkspace()` (and the Self Hosted
// app) is what keeps `BunApiBackendService` out of Hosted's static bundle.

import { Injectable, computed, inject, signal } from '@angular/core';
import { BunApiBackendService, type ApiCollisionPolicy } from '../api/bun-api-backend.service';
import { FolderCrudService } from '../api/folder-crud.service';
import { LibraryStateService } from '../state/library-state.service';
import type { AssetId } from '../models/asset';
import type { SidebarEntry } from '../models/folder';
import { childAddress, parseAddress } from '../addressing/maple-address';
import { errorMessage } from '../util/errors';
import type {
  DragMoveCapability,
  DragMoveCollisionPolicy,
  DragMoveCollisionPrompt,
} from './drag-move-capability';
import type { DragMoveItemFailure, DragMoveMode, DragMoveSummary } from './drag-move.types';

// One entry in the relocate queue (#2976 added folders): an asset goes
// through `POST /assets/:id/relocate`, a folder through
// `POST /folders/:id/move`. Both are addressed as `slug:relPath`, both
// report into the same partial-failure summary.
type QueueItem =
  | { kind: 'asset'; assetId: AssetId; filename: string }
  | { kind: 'folder'; folderId: string; name: string; sourceRelPath: string };

@Injectable({ providedIn: 'root' })
export class DragMoveService implements DragMoveCapability {
  private readonly api = inject(BunApiBackendService);
  private readonly folderCrud = inject(FolderCrudService);
  private readonly state = inject(LibraryStateService);

  readonly available = computed(() => this.state.backend === 'self-hosted');
  readonly busy = signal(false);
  readonly collisionPrompt = signal<DragMoveCollisionPrompt | null>(null);
  readonly resultSummary = signal<DragMoveSummary | null>(null);

  private queue: QueueItem[] = [];
  private mode: DragMoveMode = 'move';
  private destinationRelPath = '';
  private destinationLabel = '';
  private sourceFolderId = '';
  private destinationFolderId = '';
  private moved = 0;
  private skipped = 0;
  private failed: DragMoveItemFailure[] = [];
  private total = 0;

  dropDisabledReason(targetNode: SidebarEntry, sourceFolderId: string | null): string | null {
    if (!this.available()) return 'Move requires a Self Hosted library';
    if (targetNode.kind !== 'folder') return 'Only folders accept dropped photos';
    // Only M2-addressed (`slug:relPath`) folder nodes have a library-id +
    // relative-path pair the relocate endpoint can address — same
    // eligibility rule `folder-tree.component.ts`'s `isCrudEligible` uses.
    if (!targetNode.id.includes(':') || targetNode.id.startsWith('fs:')) {
      return 'This folder cannot be a move/copy destination';
    }
    if (sourceFolderId && targetNode.id === sourceFolderId) {
      return 'Already in this folder';
    }
    // `relocateAsset` (server) resolves `destinationPath` against the
    // ASSET'S OWN library root — it has no notion of a destination
    // `library_id` at all (`library/relocate-asset.ts`: `destDir =
    // resolveRelPathUnderRoot(libRoot, destinationPath)`, where `libRoot`
    // comes from the asset's current `fileinfo` entry, never from the
    // target node). A cross-library drop's `relPath` would silently
    // resolve inside the SOURCE library instead of the destination one —
    // confirmed live (#2644 review): a drop onto a different registered
    // library's root landed the file at the source library's own root, not
    // the target. Reject any target outside the source's own library
    // (same `slug`) until the server primitive grows a real
    // cross-library-move contract.
    if (sourceFolderId && parseAddress(targetNode.id).slug !== parseAddress(sourceFolderId).slug) {
      return "Can't move between different libraries";
    }
    return null;
  }

  beginMove(
    assetIds: AssetId[],
    sourceFolderId: string,
    targetNode: SidebarEntry,
    mode: DragMoveMode,
    folderIds: string[] = [],
  ): void {
    if (this.busy()) return;
    if (this.dropDisabledReason(targetNode, sourceFolderId)) return;

    // Only real `slug:relPath`-addressed assets have a server-managed
    // location to relocate — legacy `fs:` ids and memory-only sessions
    // don't (same exclusion `AssetRenameService.disabledReason` applies).
    const assets = assetIds
      .map((id) => this.state.assets().find((a) => a.id === id))
      .filter(
        (a): a is NonNullable<typeof a> => !!a && a.id.includes(':') && !a.id.startsWith('fs:'),
      );

    // Grid sub-folders (#2976). Move-mode only — the capability doc rules
    // folders out of copy (no recursive-copy server primitive), and the one
    // folder-passing caller (the "Move to…" dialog) is move-only anyway.
    const folders =
      mode === 'move'
        ? folderIds
            .map((id) => this.state.gridFolders().find((f) => f.id === id))
            .filter(
              (f): f is NonNullable<typeof f> =>
                !!f && f.id.includes(':') && !f.id.startsWith('fs:'),
            )
        : [];
    if (assets.length === 0 && folders.length === 0) return;

    this.queue = [
      ...assets.map<QueueItem>((a) => ({ kind: 'asset', assetId: a.id, filename: a.filename })),
      ...folders.map<QueueItem>((f) => ({
        kind: 'folder',
        folderId: f.id,
        name: f.name,
        sourceRelPath: parseAddress(f.id).relPath,
      })),
    ];
    this.mode = mode;
    this.destinationRelPath = parseAddress(targetNode.id).relPath;
    this.destinationLabel = targetNode.label;
    this.sourceFolderId = sourceFolderId;
    this.destinationFolderId = targetNode.id;
    this.moved = 0;
    this.skipped = 0;
    this.failed = [];
    this.total = this.queue.length;

    this.busy.set(true);
    this.collisionPrompt.set(null);
    this.resultSummary.set(null);
    this._processHead('skip');
  }

  resolveCollision(policy: DragMoveCollisionPolicy): void {
    if (!this.collisionPrompt()) return;
    this.collisionPrompt.set(null);
    if (policy === 'skip') {
      this.skipped++;
      this.queue.shift();
      this._processHead('skip');
      return;
    }
    this._processHead(policy);
  }

  dismissSummary(): void {
    this.resultSummary.set(null);
  }

  private _processHead(collision: ApiCollisionPolicy): void {
    const item = this.queue[0];
    if (!item) {
      this._finish();
      return;
    }
    if (item.kind === 'folder') {
      this._processFolderHead(item);
      return;
    }
    this.api.relocateAsset(item.assetId, this.mode, collision, this.destinationRelPath).subscribe({
      next: (outcome) => {
        if (outcome.kind === 'skipped') {
          if (outcome.reason === 'collision') {
            this.collisionPrompt.set({ filename: item.filename });
            return; // paused — resolveCollision() re-enters the queue
          }
          this.skipped++;
          this.queue.shift();
          this._processHead('skip');
          return;
        }
        this.moved++;
        this.queue.shift();
        this._processHead('skip');
      },
      error: (err: unknown) => {
        this.failed.push({
          assetId: item.assetId,
          filename: item.filename,
          reason: errorMessage(err),
        });
        this.queue.shift();
        this._processHead('skip');
      },
    });
  }

  /** Move one grid sub-folder via `POST /folders/:id/move` (#2976). Unlike
   * the asset path there is no collision PROMPT: a directory has no
   * Replace ("merge or clobber?" is ambiguous) or Keep Both semantics —
   * same reasoning `folder-tree-crud.component.ts`'s rename collision
   * handling documents — so a 409 records a per-item failure and the queue
   * moves on. */
  private _processFolderHead(item: Extract<QueueItem, { kind: 'folder' }>): void {
    const fail = (reason: string): void => {
      this.failed.push({ assetId: item.folderId, filename: item.name, reason });
      this.queue.shift();
      this._processHead('skip');
    };

    // Destination inside the folder being moved (itself or a descendant) —
    // the rename syscall would fail anyway; fail fast with a clear reason.
    const dest = this.destinationRelPath;
    if (dest === item.sourceRelPath || dest.startsWith(`${item.sourceRelPath}/`)) {
      fail("Can't move a folder into itself.");
      return;
    }

    // Same registered-library lookup `folder-tree-crud.component.ts`'s
    // `resolveLibraryId` uses — `/folders/:id/*` routes address the library
    // by its Mongo id, not its slug.
    const addr = parseAddress(item.folderId);
    const library = this.state
      .registeredFolders()
      .find((f) => f.slug === addr.slug || f.id === addr.slug);
    if (!library) {
      fail('Could not resolve this library — try reloading.');
      return;
    }

    const targetRelPath = childAddress(parseAddress(this.destinationFolderId), item.name).relPath;
    this.folderCrud.move(library.id, item.sourceRelPath, targetRelPath).subscribe({
      next: (outcome) => {
        if (outcome.kind === 'collision') {
          fail(`"${item.name}" already exists in the destination.`);
          return;
        }
        this.moved++;
        this.queue.shift();
        this._processHead('skip');
      },
      error: (err: unknown) => fail(errorMessage(err)),
    });
  }

  private _finish(): void {
    this.busy.set(false);
    this.resultSummary.set({
      mode: this.mode,
      targetLabel: this.destinationLabel,
      total: this.total,
      moved: this.moved,
      skipped: this.skipped,
      failed: this.failed,
    });

    // Move-mode relocated assets no longer live under the source folder —
    // the (now stale) ids in the current selection point at nothing there
    // anymore. Copy leaves the originals in place, so selection stays valid.
    if (this.mode === 'move' && this.moved > 0) {
      this.state.clearSelection();
    }

    this.state.refreshFolderListing(this.sourceFolderId);
    if (this.destinationFolderId !== this.sourceFolderId) {
      this.state.refreshFolderListing(this.destinationFolderId);
    }
    this.state.loadFolderTree();
  }
}
