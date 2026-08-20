// TrashPanelComponent — the Trash pseudo-node's contents (#2652): a paged
// list of one library's trashed assets, with per-item Restore / Delete
// Permanently, a "Restore All" (recursive folder restore), and an "Empty
// Trash" (permanent delete of everything currently in this library's
// Trash).
//
// Mounted directly (no `@defer`), the same non-`@defer`red, physical-
// separation shape `BatchRenameDialogComponent` / `MoveToDialogComponent`
// use (#2640 / #2644): only `self-hosted-browse-content.component.ts`
// (under `projects/maple`) references `<app-trash-panel>`, so plain
// tree-shaking keeps this component — and `TrashApiService`'s
// asset/folder-trash routes — out of Hosted's build entirely. See
// `trash-capability.ts`'s module doc for the companion trigger-side
// indirection (`TRASH_CAPABILITY`, injected by the eager folder-tree row
// that opens this panel).
//
// Injects `TrashApiService` and `TrashService` directly rather than through
// `TRASH_CAPABILITY` — unlike `MoveToDialogComponent` (which must keep
// working, harmlessly, under the NOOP capability because it's reachable
// from shared code), this panel is ONLY ever instantiated from the
// Self-Hosted-only host above, so there's no NOOP case to support.

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { TrashApiService } from '../api/trash-api.service';
import { TrashService } from './trash.service';
import { TrashListComponent } from './trash-list.component';
import { TrashToolbarComponent } from './trash-toolbar.component';
import { TrashDeleteConfirmDialogComponent } from './trash-delete-confirm-dialog.component';
import { errorMessage } from '../util/errors';
import { LibraryStateService } from '../state/library-state.service';
import { formatAddress, parentAddress } from '../addressing/maple-address';
import type { AssetId } from '../models/asset';
import type { TrashDeleteOutcome, TrashItem } from './trash.types';

type ConfirmTarget = { kind: 'item'; item: TrashItem } | { kind: 'all' };

@Component({
  selector: 'app-trash-panel',
  standalone: true,
  imports: [TrashListComponent, TrashToolbarComponent, TrashDeleteConfirmDialogComponent],
  templateUrl: './trash-panel.component.html',
  styleUrl: './trash-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrashPanelComponent implements OnInit {
  private readonly api = inject(TrashApiService);
  private readonly trash = inject(TrashService);
  private readonly libraryState = inject(LibraryStateService);

  readonly libraryId = input.required<string>();
  readonly libraryLabel = input.required<string>();

  readonly dismiss = output<void>();

  readonly items = signal<TrashItem[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly toast = signal<string | null>(null);

  private readonly loadedLibraryId = signal<string | null>(null);

  /** Row currently mid-restore/delete — disables just that row's buttons.
   * `'*'` marks the "Restore All" / "Empty Trash" toolbar actions as busy
   * (disables the whole list's per-row buttons too, since both operate
   * across the same list). */
  readonly busyKey = signal<AssetId | '*' | null>(null);
  readonly listBusy = computed(() => this.busyKey() !== null);

  /** Why "Restore All"/"Empty Trash" are disabled right now, or `null` when
   * they're not — surfaced to sighted users as a `title` tooltip and to
   * assistive tech via `aria-describedby` on a visually-hidden element (a
   * `disabled` attribute alone announces nothing about WHY). Both toolbar
   * actions share the same two reasons (empty list, an operation already
   * in flight), so one computed serves both buttons. */
  readonly toolbarDisabledReason = computed<string | null>(() => {
    if (this.items().length === 0) return 'Trash is empty.';
    if (this.listBusy()) return 'An operation is already in progress.';
    return null;
  });

  readonly confirmTarget = signal<ConfirmTarget | null>(null);
  readonly confirmBusy = signal(false);
  readonly confirmError = signal<string | null>(null);
  readonly confirmLabel = computed(() => {
    const target = this.confirmTarget();
    if (!target) return '';
    return target.kind === 'item' ? target.item.filename : `${this.items().length} item(s)`;
  });

  ngOnInit(): void {
    // Required inputs aren't guaranteed readable in the constructor (and
    // `TestBed.createComponent` + `setInput` never sets them until AFTER
    // construction) — `ngOnInit` is the earliest point they're reliably
    // available. The "already loaded for this id" guard in
    // `loadFirstPageIfNeeded` defensively covers a `libraryId` swap
    // without a full component teardown too, even though the host always
    // mounts a fresh instance per open today.
    this.loadFirstPageIfNeeded();
  }

  private loadFirstPageIfNeeded(): void {
    const id = this.libraryId();
    if (this.loadedLibraryId() === id) return;
    this.loadedLibraryId.set(id);
    this.loadPage(true);
  }

  private loadPage(reset: boolean): void {
    this.loading.set(true);
    this.loadError.set(null);
    const cursor = reset ? null : this.nextCursor();
    this.api.listTrash(this.libraryId(), cursor).subscribe({
      next: (page) => {
        this.loading.set(false);
        this.items.set(reset ? page.items : [...this.items(), ...page.items]);
        this.nextCursor.set(page.nextCursor);
      },
      error: (err: unknown) => {
        this.loading.set(false);
        this.loadError.set(errorMessage(err));
      },
    });
  }

  loadMore(): void {
    if (this.loading() || this.nextCursor() === null) return;
    this.loadPage(false);
  }

  onClose(): void {
    this.dismiss.emit();
  }

  // ── Restore ──────────────────────────────────────────────────────────────

  /** Re-pull the currently OPEN folder's listing if (and only if) a restore
   * just landed an asset back into it — same "refresh, don't mutate"
   * pattern `DragMoveService._finish()` uses for relocate. `restoreAsset`
   * puts each item back at its recorded `originalRelativePath` (a
   * collision-safe restore only renames the filename, never the folder —
   * see `TrashApiService.restoreAsset`'s doc), so the destination folder is
   * that path's parent.
   *
   * A restore can land in a folder other than the one currently open (a
   * "Restore All" from the library root, or an item trashed from a
   * different folder than the user is now browsing) — refreshing an
   * off-screen folder would be a wasted round trip, so this only fires when
   * the affected folder is the one actually visible.
   *
   * `libraryId()` is the registered library's Mongo id (`libraryIdForRootNode`
   * — see `trash-node.ts`), NOT the `slug` that `selectedSourceId`/folder-tree
   * ids use. Resolve the real slug via `registeredFolders()` before building
   * `slug:relPath` addresses to compare — comparing against the raw Mongo id
   * would never match. */
  private refreshVisibleFolderAfterRestore(originalRelativePaths: string[]): void {
    const openId = this.libraryState.selectedSourceId();
    if (!openId) return;
    const slug = this.libraryState.registeredFolders().find((f) => f.id === this.libraryId())?.slug;
    if (!slug) return;
    const affected = new Set(
      originalRelativePaths.map((relPath) =>
        formatAddress(parentAddress({ slug, relPath }) ?? { slug, relPath: '' }),
      ),
    );
    if (affected.has(openId)) {
      this.libraryState.refreshFolderListing(openId);
    }
  }

  onRestoreItem(item: TrashItem): void {
    if (this.busyKey() !== null) return;
    this.busyKey.set(item.assetId);
    this.api.restoreAsset(item.assetId, item.filename).subscribe({
      next: (result) => {
        this.busyKey.set(null);
        this.items.set(this.items().filter((i) => i.assetId !== item.assetId));
        this.toast.set(
          result.renamedTo
            ? `Restored as "${result.renamedTo}" — "${item.filename}" already existed at the destination.`
            : `Restored "${item.filename}".`,
        );
        this.trash.notifyLibraryMutated(this.libraryId());
        this.refreshVisibleFolderAfterRestore([item.originalRelativePath]);
      },
      error: (err: unknown) => {
        this.busyKey.set(null);
        this.toast.set(`Couldn't restore "${item.filename}": ${errorMessage(err)}`);
      },
    });
  }

  onRestoreAll(): void {
    if (this.busyKey() !== null || this.items().length === 0) return;
    this.busyKey.set('*');
    this.api.restoreFolder(this.libraryId(), '').subscribe({
      next: (summary) => {
        this.busyKey.set(null);
        const succeededIds = new Set(summary.items.filter((i) => i.ok).map((i) => i.assetId));
        const succeededPaths = this.items()
          .filter((i) => succeededIds.has(i.assetId))
          .map((i) => i.originalRelativePath);
        this.items.set(this.items().filter((i) => !succeededIds.has(i.assetId)));
        this.toast.set(
          summary.failed > 0
            ? `Restored ${summary.succeeded} of ${summary.total} item(s) — ${summary.failed} failed.`
            : `Restored ${summary.succeeded} item(s).`,
        );
        this.trash.notifyLibraryMutated(this.libraryId());
        this.refreshVisibleFolderAfterRestore(succeededPaths);
      },
      error: (err: unknown) => {
        this.busyKey.set(null);
        this.toast.set(`Restore All failed: ${errorMessage(err)}`);
      },
    });
  }

  // ── Delete Permanently ──────────────────────────────────────────────────

  requestDeleteItem(item: TrashItem): void {
    this.confirmError.set(null);
    this.confirmTarget.set({ kind: 'item', item });
  }

  requestDeleteAll(): void {
    if (this.items().length === 0) return;
    this.confirmError.set(null);
    this.confirmTarget.set({ kind: 'all' });
  }

  dismissConfirm(): void {
    if (this.confirmBusy()) return;
    this.confirmTarget.set(null);
    this.confirmError.set(null);
  }

  onConfirmDelete(): void {
    const target = this.confirmTarget();
    if (!target || this.confirmBusy()) return;
    if (target.kind === 'item') {
      this.deleteOneItemPermanently(target.item);
      return;
    }
    void this.deleteAllPermanently();
  }

  /** Force the panel's own list to re-fetch from the server rather than
   * trust its in-memory `items` — used only on a `state: 'live'` 409 (#2749):
   * the item this panel still shows as trashed was actually restored
   * elsewhere since the list was fetched, so the client's whole view of
   * this library's Trash is stale, not just the one row. */
  private refreshListingAfterConflict(): void {
    this.loadedLibraryId.set(null);
    this.loadFirstPageIfNeeded();
  }

  private deleteOneItemPermanently(item: TrashItem): void {
    this.confirmBusy.set(true);
    // `intent: 'purge'` (#2749) — a single-item "Delete Permanently" only
    // ever means "purge this trashed asset." A 409 with `state: 'live'`
    // means it was restored (by this user elsewhere, or by someone else)
    // between the panel loading it and this confirm — the dialog said
    // "cannot be undone," so it must NOT silently re-trash a now-live
    // photo to make that true; report the real outcome and refresh.
    this.api.deleteAsset(item.assetId, 'purge').subscribe({
      next: (outcome) => {
        this.confirmBusy.set(false);
        this.confirmTarget.set(null);
        if (outcome.kind === 'ok') {
          this.items.set(this.items().filter((i) => i.assetId !== item.assetId));
          this.toast.set(`Permanently deleted "${item.filename}".`);
          this.trash.notifyLibraryMutated(this.libraryId());
          return;
        }
        this.toast.set(`"${item.filename}" was restored elsewhere — not deleted.`);
        this.refreshListingAfterConflict();
        this.trash.notifyLibraryMutated(this.libraryId());
      },
      error: (err: unknown) => {
        this.confirmBusy.set(false);
        this.confirmError.set(errorMessage(err));
      },
    });
  }

  /** Deletes every item currently loaded in the panel's list one at a time
   * (the server has no batch permanent-delete endpoint — see
   * `trash-api.service.ts`'s header). Loaded items only, not the whole
   * library's trash sight-unseen: if more pages exist (`nextCursor` was
   * non-null before this ran), the toast says so explicitly rather than
   * silently claiming "Trash emptied" when older items remain unseen.
   *
   * Each call passes `intent: 'purge'` (#2749); a per-item `state: 'live'`
   * 409 (restored elsewhere since this list loaded) is tallied separately
   * from a real failure and reported by name, not folded into "failed". */
  private async deleteAllPermanently(): Promise<void> {
    this.confirmBusy.set(true);
    const targets = this.items();
    const hadMorePages = this.nextCursor() !== null;
    let deleted = 0;
    let failed = 0;
    const restoredElsewhere: string[] = [];
    for (const item of targets) {
      try {
        const outcome = await new Promise<TrashDeleteOutcome>((resolve, reject) => {
          this.api.deleteAsset(item.assetId, 'purge').subscribe({
            next: resolve,
            error: reject,
          });
        });
        if (outcome.kind === 'ok') {
          deleted += 1;
        } else {
          restoredElsewhere.push(item.filename);
        }
      } catch {
        failed += 1;
      }
    }
    this.confirmBusy.set(false);
    this.confirmTarget.set(null);
    if (restoredElsewhere.length > 0) {
      // At least one item's state didn't match what this panel had
      // loaded — trust the server's re-fetch over the client's filtered
      // `items` array rather than guessing which other rows might also be
      // stale.
      this.refreshListingAfterConflict();
    } else {
      this.loadedLibraryId.set(null);
      this.loadFirstPageIfNeeded();
    }
    const moreNote = hadMorePages
      ? ' More items remain further back in Trash — reopen Empty Trash to continue.'
      : '';
    const restoredNote =
      restoredElsewhere.length > 0
        ? ` ${restoredElsewhere.length} were restored elsewhere and not deleted (${restoredElsewhere.join(', ')}).`
        : '';
    this.toast.set(
      failed > 0
        ? `Permanently deleted ${deleted} of ${targets.length} item(s) — ${failed} failed.${restoredNote}${moreNote}`
        : `Permanently deleted ${deleted} item(s).${restoredNote}${moreNote}`,
    );
    this.trash.notifyLibraryMutated(this.libraryId());
  }

  dismissToast(): void {
    this.toast.set(null);
  }
}
