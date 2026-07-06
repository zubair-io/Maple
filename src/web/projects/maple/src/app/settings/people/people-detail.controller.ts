// PeopleDetailController — plain-TS controller for the detail-view face
// actions on the `/settings/people/:id` page: set-as-cover, open-in-editor,
// and infinite-scroll pagination.
//
// Extracted from `PeopleComponent` to satisfy the 600-LOC file budget,
// mirroring `PeopleBulkController`: a plain class with deps threaded through
// the constructor, instantiated once per component instance. Signals and
// computeds work outside an injection context; only `effect()` needs one
// (not used here). DI / signal wiring stays in the component; this file owns
// the pure-ish action logic.

import { computed, type Signal, type WritableSignal } from '@angular/core';
import { Router } from '@angular/router';
import {
  type ApiPersonDetail,
  type ApiPersonFace,
  PeopleStore,
  viewRouteCommands,
} from '@maple-common';
import { errorMessage, faceKey, type Tone } from './people.vm';

export interface PeopleDetailDeps {
  store: PeopleStore;
  router: Router;
  /** The open person detail, or null on the list view. */
  selected: Signal<ApiPersonDetail | null>;
  /** The per-face selection set (keyed by `assetId:faceIndex`). */
  selectedFaces: Signal<ReadonlySet<string>>;
  /** Clears the per-face selection (owned by the component). */
  clearSelection: () => void;
  /** Shared in-flight counter — disables the bulk toolbar while > 0. */
  bulkBusy: WritableSignal<number>;
  toast: (text: string, tone: Tone) => void;
}

export class PeopleDetailController {
  constructor(private readonly deps: PeopleDetailDeps) {}

  // ── Set as cover ──────────────────────────────────────────────────────

  /** "Set as cover" — only enabled when exactly one face is selected. */
  readonly canSetCover = computed<boolean>(() => this.deps.selectedFaces().size === 1);

  /** Pin the single selected face as the person's cover. The store invalidates
   * both the detail and the list so the new poster shows on both. */
  async setSelectedAsCover(): Promise<void> {
    const detail = this.deps.selected();
    if (!detail || !this.canSetCover()) return;
    const [key] = [...this.deps.selectedFaces()];
    const face = detail.faces.find((f) => faceKey(f) === key);
    if (!face) return;
    this.deps.bulkBusy.update((n) => n + 1);
    try {
      await this.deps.store.setPersonCover(detail.id, face.assetId, face.faceIndex);
      this.deps.clearSelection();
      this.deps.toast('Cover updated', 'success');
    } catch (err) {
      this.deps.toast(errorMessage(err), 'error');
    } finally {
      this.deps.bulkBusy.update((n) => Math.max(0, n - 1));
    }
  }

  // ── Open in Preview (Feature 2) ────────────────────────────────────────

  openInEditor(face: ApiPersonFace): void {
    void this.deps.router.navigate(viewRouteCommands(face.assetId));
  }

  // ── Infinite scroll (Feature 3) ───────────────────────────────────────

  /** True when more face pages are available for the current person. */
  readonly hasMoreFaces = computed<boolean>(() => this.deps.store.detailHasMore());

  /** Load the next page of faces; called when the grid scrolls near the bottom. */
  loadMoreFaces(): void {
    const detail = this.deps.selected();
    if (!detail) return;
    this.deps.store.loadMoreFaces(detail.id);
  }
}
