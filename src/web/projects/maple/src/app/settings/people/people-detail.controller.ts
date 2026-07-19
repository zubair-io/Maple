// PeopleDetailController — plain-TS controller for the detail-view face
// actions on the `/settings/people/:id` page: set-as-cover, open-in-preview,
// infinite-scroll pagination, detail thumb prefetch, and the
// merge-suggestion "compare faces" strip.
//
// Extracted from `PeopleComponent` to satisfy the 600-LOC file budget,
// mirroring `PeopleBulkController`: a plain class with deps threaded through
// the constructor, instantiated once per component instance. Signals and
// computeds work outside an injection context; only `effect()` needs one
// (not used here). DI / signal wiring stays in the component; this file owns
// the pure-ish action logic.

import { computed, signal, untracked, type Signal, type WritableSignal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  BunApiBackendService,
  type ApiPerson,
  type ApiPersonDetail,
  type ApiPersonFace,
  PeopleStore,
  viewRouteCommands,
} from '@maple-common';
import { errorMessage, faceKey, type Tone } from './people.vm';
import { ThumbBlobCache } from './thumb-blob-cache';

export interface PeopleDetailDeps {
  store: PeopleStore;
  api: BunApiBackendService;
  router: Router;
  /** The open person detail, or null on the list view. */
  selected: Signal<ApiPersonDetail | null>;
  /** The loaded people list — used to resolve a person's canonical cover
   * cache key (the same one the list grid populates). */
  people: Signal<ApiPerson[]>;
  /** The component's blob cache — thumbs are ensured here so the banner and
   * face strips resolve the same keys the templates read. */
  thumbs: ThumbBlobCache;
  /** The per-face selection set (keyed by `assetId:faceIndex`). */
  selectedFaces: Signal<ReadonlySet<string>>;
  /** Clears the per-face selection (owned by the component). */
  clearSelection: () => void;
  /** Shared in-flight counter — disables the bulk toolbar while > 0. */
  bulkBusy: WritableSignal<number>;
  toast: (text: string, tone: Tone) => void;
}

/** Face crops fetched for the banner's "Compare faces" strip. */
const SUGGESTION_FACE_LIMIT = 12;

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

  openInPreview(face: ApiPersonFace): void {
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

  // ── Detail thumb prefetch (#2078) ─────────────────────────────────────

  /**
   * Eagerly fetch every thumb the detail view renders: the visible face
   * grid, the open person's own cover, and the merge-suggestion banner's
   * avatar. Called from the component's detail effect, so it re-runs (and
   * re-ensures) when the detail or the people list changes — the banner
   * avatar previously never loaded because nothing ever `ensure`d it (the
   * list grid only ensures covers for cards that became visible).
   *
   * Also collapses the "Compare faces" strip whenever the suggestion
   * changes or clears, so a stale strip can't outlive its banner.
   */
  prefetchDetailThumbs(): void {
    const detail = this.deps.selected();
    if (!detail) return;
    for (const f of detail.faces) {
      this.deps.thumbs.ensure(f.absPath, null, f.absPath, f.assetId);
    }
    this.ensurePersonCover(detail.id, detail.coverAssetId);
    const suggestion = detail.suggestedMerge;
    if (suggestion) this.ensurePersonCover(suggestion.personId, suggestion.coverAssetId);
    if ((suggestion?.personId ?? null) !== this.suggestionFacesFor) {
      this.suggestionFacesFor = null;
      // `untracked` for explicitness: this runs inside the component's
      // detail effect, and the write must not be mistaken for a tracked
      // read (signal writes in effects are legal in Angular 19+).
      untracked(() => this.suggestionFaces.set(null));
    }
  }

  /** Ensure a person's cover thumb under the SAME cache key the templates
   * resolve: the list row's canonical key when the person is in the loaded
   * list, else the `apiId:` fallback from the detail payload. */
  private ensurePersonCover(personId: string, coverAssetId: string | null): void {
    const original = this.deps.people().find((p) => p.id === personId);
    if (original) {
      const key = ThumbBlobCache.coverKey(original);
      if (key) {
        this.deps.thumbs.ensure(
          key,
          original.coverAddress ?? null,
          original.coverAbsPath,
          original.coverAssetId,
        );
      }
      return;
    }
    if (coverAssetId) this.deps.thumbs.ensure(`apiId:${coverAssetId}`, null, null, coverAssetId);
  }

  // ── Merge-suggestion "Compare faces" strip (#2078) ────────────────────

  /** Face crops of the suggested duplicate; null while collapsed. */
  readonly suggestionFaces = signal<ApiPersonFace[] | null>(null);

  /** True while the strip's face page is being fetched. */
  readonly suggestionFacesLoading = signal<boolean>(false);

  /** Person id the current strip belongs to — `prefetchDetailThumbs`
   * collapses the strip when the live suggestion stops matching it. */
  private suggestionFacesFor: string | null = null;

  /** Expand/collapse the strip. Expanding fetches one page of the suggested
   * person's faces straight from the API — deliberately NOT through the
   * store's detail cache, so the open person's own detail state (active id,
   * pagination) is untouched. */
  async toggleSuggestionFaces(): Promise<void> {
    const suggestion = this.deps.selected()?.suggestedMerge;
    if (!suggestion) return;
    if (this.suggestionFaces() !== null) {
      this.suggestionFacesFor = null;
      this.suggestionFaces.set(null);
      return;
    }
    this.suggestionFacesLoading.set(true);
    try {
      const detail = await firstValueFrom(
        this.deps.api.getPerson(suggestion.personId, {
          offset: 0,
          limit: SUGGESTION_FACE_LIMIT,
        }),
      );
      // Discard a stale response: the user may have navigated to another
      // person (or the suggestion may have changed/cleared) while the fetch
      // was in flight — populating now would open the strip with the wrong
      // person's faces under the new banner.
      if (this.deps.selected()?.suggestedMerge?.personId !== suggestion.personId) return;
      for (const f of detail.faces) {
        this.deps.thumbs.ensure(f.absPath, null, f.absPath, f.assetId);
      }
      this.suggestionFacesFor = suggestion.personId;
      this.suggestionFaces.set(detail.faces);
    } catch (err) {
      this.deps.toast(errorMessage(err), 'error');
    } finally {
      this.suggestionFacesLoading.set(false);
    }
  }
}
