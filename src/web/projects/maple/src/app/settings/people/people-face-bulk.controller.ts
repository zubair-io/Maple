// PeopleFaceBulkController — plain-TS controller for the detail-view's
// per-face selection set and the bulk actions that act on it (move to
// another person, unassign, hide).
//
// Extracted from `PeopleComponent` to satisfy the 600-LOC file budget,
// mirroring `PeopleBulkController` (list-view person selection/merge/hide)
// and `PeopleDetailController` (single-face detail actions): a plain class
// with deps threaded through the constructor, instantiated once per
// component instance. Signals and computeds work outside an injection
// context; only `effect()` needs one (not used here).
//
// `PeopleBulkController` operates on PEOPLE (list-view rows); this
// controller operates on FACES within the currently-open person's detail
// view — a distinct selection set, keyed by `assetId:faceIndex`.

import { signal, type Signal, type WritableSignal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { ApiPersonDetail, ApiPersonFace, BunApiBackendService } from '@maple-common';
import {
  bulkFailureLabel,
  bulkSuccessLabel,
  errorMessage,
  faceKey,
  pickSelectedFaces,
  selectAllKeys,
  toggleSelection,
  type Tone,
} from './people.vm';

export interface PeopleFaceBulkDeps {
  api: BunApiBackendService;
  /** The open person detail, or null on the list view. */
  selected: Signal<ApiPersonDetail | null>;
  /** Faces currently passing the confidence-threshold filter — what
   * "Select all" selects. */
  visibleFaces: Signal<ApiPersonFace[]>;
  /** Shared in-flight counter — disables the bulk toolbar while > 0. Shared
   * with `PeopleDetailController`'s set-as-cover action so the two can't
   * race each other undetected. */
  bulkBusy: WritableSignal<number>;
  /** Force a fresh fetch of the open person's detail after a mutation. */
  openDetail: (id: string) => void;
  /** Re-fetch the people list after a mutation changes membership/counts. */
  refresh: () => void;
  toast: (text: string, tone: Tone) => void;
}

export class PeopleFaceBulkController {
  constructor(private readonly deps: PeopleFaceBulkDeps) {}

  /** Per-face selection set for bulk actions. Keyed by `assetId:faceIndex`
   * so we can intersect with the detail's faces list cleanly. */
  readonly selectedFaces = signal<ReadonlySet<string>>(new Set());

  isFaceSelected(face: { assetId: string; faceIndex: number }): boolean {
    return this.selectedFaces().has(faceKey(face));
  }

  toggleFaceSelection(face: { assetId: string; faceIndex: number }): void {
    this.selectedFaces.set(toggleSelection(this.selectedFaces(), face));
  }

  clearSelection(): void {
    this.selectedFaces.set(new Set());
  }

  selectAllVisible(): void {
    this.selectedFaces.set(selectAllKeys(this.deps.visibleFaces()));
  }

  /** Fan one bulk action out over the current selection. `verb` is the
   * past-tense word the toast uses ("Moved", "Unassigned", "Hid") so each
   * action stays grammatically clean without duplicating the try/finally
   * + busy-counter scaffolding.
   *
   * Uses `Promise.allSettled` rather than `Promise.all` so a single
   * per-face failure doesn't abort the whole batch: any face that did
   * succeed is now on a different person / hidden, and skipping the
   * refresh would leave the UI lying about server state. The toast
   * surfaces the success/failure split; failures still flow into the
   * error toast so the operator sees what went wrong. */
  private async bulkApply(
    verb: string,
    fn: (face: ApiPersonFace) => Promise<unknown>,
  ): Promise<void> {
    const faces = pickSelectedFaces(this.deps.selected(), this.selectedFaces());
    if (faces.length === 0) return;
    this.deps.bulkBusy.update((n) => n + 1);
    try {
      const results = await Promise.allSettled(faces.map(fn));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;

      if (ok > 0) {
        this.deps.toast(bulkSuccessLabel(verb, ok), 'success');
      }
      if (failed > 0) {
        const firstReject = results.find(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        const reason = firstReject ? errorMessage(firstReject.reason) : 'unknown error';
        this.deps.toast(bulkFailureLabel(failed, reason), 'error');
      }
    } finally {
      // Always clear selection + refresh, even on partial / total failure
      // — the server state for the successful faces moved, so leaving the
      // UI alone would lie about what's where.
      this.clearSelection();
      const open = this.deps.selected();
      if (open) this.deps.openDetail(open.id);
      this.deps.refresh();
      this.deps.bulkBusy.update((n) => Math.max(0, n - 1));
    }
  }

  bulkMoveTo(personId: string): Promise<void> {
    const target = personId.trim();
    if (!target) return Promise.resolve();
    return this.bulkApply('Moved', (f) =>
      firstValueFrom(this.deps.api.assignFaceToPerson(f.assetId, f.faceIndex, target)),
    );
  }

  bulkUnassign(): Promise<void> {
    return this.bulkApply('Unassigned', (f) =>
      firstValueFrom(this.deps.api.assignFaceToPerson(f.assetId, f.faceIndex, null)),
    );
  }

  bulkHide(): Promise<void> {
    return this.bulkApply('Hid', (f) =>
      firstValueFrom(this.deps.api.hideFace(f.assetId, f.faceIndex)),
    );
  }
}
