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
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { TrashApiService } from '../api/trash-api.service';
import { TrashService } from './trash.service';
import { TrashItemRowComponent } from './trash-item-row.component';
import { TrashDeleteConfirmDialogComponent } from './trash-delete-confirm-dialog.component';
import { errorMessage } from '../util/errors';
import type { AssetId } from '../models/asset';
import type { TrashItem } from './trash.types';

type ConfirmTarget = { kind: 'item'; item: TrashItem } | { kind: 'all' };

@Component({
  selector: 'app-trash-panel',
  standalone: true,
  imports: [TrashItemRowComponent, TrashDeleteConfirmDialogComponent],
  templateUrl: './trash-panel.component.html',
  styleUrl: './trash-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrashPanelComponent {
  private readonly api = inject(TrashApiService);
  private readonly trash = inject(TrashService);

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

  isRowBusy(assetId: AssetId): boolean {
    const key = this.busyKey();
    return key === assetId || key === '*';
  }

  readonly confirmTarget = signal<ConfirmTarget | null>(null);
  readonly confirmBusy = signal(false);
  readonly confirmError = signal<string | null>(null);
  readonly confirmLabel = computed(() => {
    const target = this.confirmTarget();
    if (!target) return '';
    return target.kind === 'item' ? target.item.filename : `${this.items().length} item(s)`;
  });

  constructor() {
    // `input.required` fields are set before the first change-detection
    // pass, so a plain "load on construction, reload if the id ever
    // changes" check in the getter-driven effect below covers both the
    // initial open and (defensively) a libraryId swap without a full
    // component teardown, even though the host always mounts a fresh
    // instance per open today.
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
        this.items.set(this.items().filter((i) => !succeededIds.has(i.assetId)));
        this.toast.set(
          summary.failed > 0
            ? `Restored ${summary.succeeded} of ${summary.total} item(s) — ${summary.failed} failed.`
            : `Restored ${summary.succeeded} item(s).`,
        );
        this.trash.notifyLibraryMutated(this.libraryId());
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

  private deleteOneItemPermanently(item: TrashItem): void {
    this.confirmBusy.set(true);
    this.api.deleteAsset(item.assetId).subscribe({
      next: () => {
        this.confirmBusy.set(false);
        this.confirmTarget.set(null);
        this.items.set(this.items().filter((i) => i.assetId !== item.assetId));
        this.toast.set(`Permanently deleted "${item.filename}".`);
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
   * silently claiming "Trash emptied" when older items remain unseen. */
  private async deleteAllPermanently(): Promise<void> {
    this.confirmBusy.set(true);
    const targets = this.items();
    const hadMorePages = this.nextCursor() !== null;
    let deleted = 0;
    let failed = 0;
    for (const item of targets) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.api.deleteAsset(item.assetId).subscribe({ next: () => resolve(), error: reject });
        });
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
    this.confirmBusy.set(false);
    this.confirmTarget.set(null);
    this.loadedLibraryId.set(null); // force a fresh first page below
    this.loadFirstPageIfNeeded();
    const moreNote = hadMorePages
      ? ' More items remain further back in Trash — reopen Empty Trash to continue.'
      : '';
    this.toast.set(
      failed > 0
        ? `Permanently deleted ${deleted} of ${targets.length} item(s) — ${failed} failed.${moreNote}`
        : `Permanently deleted ${deleted} item(s).${moreNote}`,
    );
    this.trash.notifyLibraryMutated(this.libraryId());
  }

  dismissToast(): void {
    this.toast.set(null);
  }
}
