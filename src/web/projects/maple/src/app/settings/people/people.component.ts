// PeopleComponent — `/settings/people` (auth + owner-gated).
//
// Operator surface for the face-cluster identities ("People"), wrapped in
// the shared SettingsShell so it lives alongside Account / Workers / Users.
// `selected()` is the URL-driven detail state — when set, the page renders
// a full-width detail view (header + filter bar + face grid + floating
// selection toolbar) that replaces the list view entirely. When null, the
// list view (page header + stats line + card grid) renders.
//
// The route `/settings/people/:id` deep-links into the detail view. URL
// is the single source of truth: a `selectedRouteId` computed signal
// reads paramMap, and a constructor-time effect fires GET /api/people/:id
// whenever the id changes. Computed signals dedupe by equality, so
// duplicate paramMap emissions for the same id don't re-fetch.
//
// Renaming a person to a name that already exists triggers a SERVER-SIDE
// merge — the response includes `mergedFrom` so the UI can show the
// "Merged into {name}" toast.
//
// List-view bulk people selection / merge / hide lives in
// {@link PeopleBulkController} (co-located). Bearer-gated thumb loading
// lives in {@link ThumbBlobCache}. Pure derivation lives in `./people.vm.ts`.
// This file owns DI, signal wiring, and side effects.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  ApiMergeSuggestion,
  ApiPerson,
  ApiPersonDetail,
  ApiPersonFace,
  BunApiBackendService,
  FilesystemBrowseService,
  LIBRARY_SOURCE,
  type LibrarySource,
  PeopleStore,
} from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';
import { SettingsIconComponent } from '../settings-icon.component';
import { MapleVisibleOnceDirective } from './visible-once.directive';
import { ThumbBlobCache } from './thumb-blob-cache';
import { PeopleGridHost, bindGridViewport, createToast } from './people-grid-layout';
import { FaceThumbCrop } from './face-thumb-crop';
import {
  TOAST_TTL_MS,
  Toast,
  Tone,
  averageConfidence,
  chunkPeopleRows,
  clusteringSummary,
  errorMessage,
  faceKey,
  filterNamed,
  hiddenFaceCount,
  isAutoNamed,
  PEOPLE_GRID,
  peopleCardWidth,
  peopleGridColumns,
  peopleRowHeight,
  peopleRowKey,
  peopleStats,
  sortPeople,
  SMALL_CLUSTER_MIN_FACES,
  filterSmallClusters,
  visibleFaces,
} from './people.vm';
import { PeopleBulkController } from './people-bulk.controller';
import { PeopleDetailController } from './people-detail.controller';
import { PeopleFaceBulkController } from './people-face-bulk.controller';

@Component({
  standalone: true,
  selector: 'maple-people',
  imports: [
    DecimalPipe,
    FormsModule,
    RouterLink,
    ScrollingModule,
    SettingsShellComponent,
    SettingsIconComponent,
    MapleVisibleOnceDirective,
  ],
  templateUrl: './people.component.html',
  styleUrl: './people.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PeopleComponent extends PeopleGridHost {
  /** Redeclared over PeopleGridHost's field (same root singleton): direct
   * `this.api.renamePerson(...)`-style calls in this file need a local
   * declaration for cross-file reference analysis to bind against. */
  protected override readonly api = inject(BunApiBackendService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  /** SWR cache for the people list + per-person detail. Renders cached data
   * instantly on re-navigation and revalidates in the background. */
  private readonly store = inject(PeopleStore);

  /** List view, fed by the store. `?? []` so the template's `@for` and stats
   * see an array before the first fetch resolves (the store's `data()` is
   * `undefined` until then). */
  readonly people = computed<ApiPerson[]>(() => this.store.data() ?? []);

  /** Surfaces either the list error or the active-detail error — the template
   * shows a single "Failed to load" toast. Normalised to a string message. */
  readonly loadError = computed<string | null>(() => {
    const err = this.store.error() ?? this.store.detailError();
    return err ? errorMessage(err) : null;
  });

  readonly clusteringBusy = signal<boolean>(false);

  /** Active person detail, fed by the store's id-keyed cache. `?? null`
   * matches the previous signal's shape (the template branches on truthiness). */
  readonly selected = computed<ApiPersonDetail | null>(() => this.store.detail() ?? null);

  /** First-fetch of the open detail (no cached value to show). A background
   * refresh of an already-cached detail does NOT flip this — the cached panel
   * stays on screen, matching SWR semantics. */
  readonly selectedLoading = computed<boolean>(() => this.store.detailLoading());

  readonly editingId = signal<string | null>(null);
  readonly draftName = signal<string>('');

  private readonly toastCtl = createToast();
  readonly toast = this.toastCtl.toast;

  /** Minimum detector confidence (0-100) for the visible-faces filter.
   * Labelled "Min detector confidence" in the UI — the API's
   * `face.confidence` is the SCRFD detector's face-likelihood score, NOT
   * cluster-match similarity. The design called this "Min match" / "Similarity";
   * we relabel honestly rather than overload the data. */
  readonly threshold = signal<number>(60);

  /** Hovered face id (for the hover-to-reveal checkbox). Null when no
   * face is hovered. */
  readonly hoveredFace = signal<string | null>(null);

  /** Live in-flight count for bulk operations. While > 0 the floating
   * toolbar disables its buttons to prevent overlapping batches. */
  readonly bulkBusy = signal<number>(0);

  readonly hasPeople = computed(() => this.people().length > 0);

  readonly peopleStats = computed(() => peopleStats(this.people()));

  readonly sortedPeople = computed(() => sortPeople(this.people()));

  readonly namedPeople = computed(() => filterNamed(this.sortedPeople()));

  /** "Hide small clusters" toggle — on by default so the long tail of tiny
   * stray-detection clusters doesn't bury the real identities. */
  readonly hideSmallClusters = signal<boolean>(true);

  /** Template re-exposure of the face-count floor for the toggle's label. */
  protected readonly smallClusterMin = SMALL_CLUSTER_MIN_FACES;

  /** The rows the GRID renders. `namedPeople` (merge targets) and
   * `peopleStats` deliberately stay on the unfiltered list — hiding a
   * cluster from the grid must not make it un-mergeable or change the
   * whole-library summary. */
  readonly visiblePeople = computed(() =>
    this.hideSmallClusters()
      ? filterSmallClusters(this.sortedPeople(), SMALL_CLUSTER_MIN_FACES)
      : this.sortedPeople(),
  );

  /** How many rows the toggle is currently hiding — surfaced next to it so
   * nothing disappears silently. */
  readonly hiddenSmallCount = computed(
    () => this.sortedPeople().length - this.visiblePeople().length,
  );

  /** Bulk list-selection / merge / hide controller. Declared after `store`,
   * `router`, `people`, `namedPeople`, and `selected` so field initializers
   * that reference those are already resolved. */
  readonly bulk = new PeopleBulkController({
    store: this.store,
    router: this.router,
    people: this.people,
    namedPeople: this.namedPeople,
    selected: this.selected,
    toast: (text, tone) => this.showToast(text, tone),
  });

  // ── List-view virtual scroll ────────────────────────────────────────────
  // The list grid is windowed by `cdk-virtual-scroll-viewport`: sorted people
  // are packed into fixed-height rows of `gridColumns()` cards (see the
  // row-packing helpers in people.vm.ts) and the ROWS are virtualised. The
  // `(mapleVisibleOnce)` cover-lazy-load still fires per card as rows mount.

  /** Virtual-scroll viewport host. Signal query (not a static ViewChild)
   * because it lives in conditional template blocks — only present in the
   * populated list view, and re-appears on back-navigation. */
  private readonly peopleScrollContent = viewChild('peopleScrollContent', { read: ElementRef });

  /** Sorted people packed into fixed-width rows for the virtual viewport. */
  readonly peopleRows = computed(() => chunkPeopleRows(this.visiblePeople(), this.gridColumns()));

  /** Track-by for virtualised rows (see `peopleRowKey`). */
  trackRow = peopleRowKey;

  readonly visibleFaces = computed(() => {
    const detail = this.selected();
    if (!detail) return [];
    return visibleFaces(detail.faces, this.threshold());
  });

  readonly hiddenFaceCount = computed(() => {
    const detail = this.selected();
    if (!detail) return 0;
    return hiddenFaceCount(detail.faces, this.threshold());
  });

  readonly averageConfidence = computed(() => {
    const detail = this.selected();
    return detail ? averageConfidence(detail.faces) : 0;
  });

  /** True when the open detail's name is an auto-assigned "Person N"
   * placeholder. Drives the "Unnamed" chip + plus-icon vs edit-icon. */
  readonly isSelectedAutoNamed = computed(() => {
    const detail = this.selected();
    return detail ? isAutoNamed(detail.name) : false;
  });

  /** Template re-exposure of the auto-name predicate so the list-view
   * card can use the same `^Person N$` rule. */
  protected readonly isAutoName = isAutoNamed;

  /** Face-thumbnail crop-transform state (natural-dims capture + transform).
   * Shared by the list cover thumbs and the detail face grid. */
  protected readonly crop = new FaceThumbCrop();

  /** Detail-view per-face selection + bulk move/unassign/hide. Declared
   * before {@link detailCtl}, which reads its `selectedFaces` signal. */
  readonly faceBulk = new PeopleFaceBulkController({
    api: this.api,
    selected: this.selected,
    visibleFaces: this.visibleFaces,
    bulkBusy: this.bulkBusy,
    openDetail: (id) => this.openDetail(id),
    refresh: () => this.refresh(),
    toast: (text, tone) => this.showToast(text, tone),
  });

  /** Detail-view face actions: set-as-cover, open-in-editor, infinite
   * scroll, thumb prefetch, and the merge-suggestion compare strip.
   * Declared after {@link thumbs} — field-initializer order. */
  readonly detailCtl = new PeopleDetailController({
    store: this.store,
    api: this.api,
    router: this.router,
    selected: this.selected,
    people: this.people,
    thumbs: this.thumbs,
    selectedFaces: this.faceBulk.selectedFaces,
    clearSelection: () => this.faceBulk.clearSelection(),
    bulkBusy: this.bulkBusy,
    toast: (text, tone) => this.showToast(text, tone),
  });

  /** Route paramMap as a signal — `toSignal` registers a teardown against
   * the component's DestroyRef, so no manual unsubscribe is needed. */
  private readonly routeParamMap = toSignal(this.route.paramMap, {
    initialValue: this.route.snapshot.paramMap,
  });

  /** The `:id` segment from the URL, or `null` for `/settings/people`.
   * Computed (reference-stable on equal values) so the detail-fetch
   * effect only fires on actual id changes — replaces the imperative
   * `_lastFetchedId` race guard the previous subscribe() needed. */
  readonly selectedRouteId = computed(() => this.routeParamMap().get('id'));

  constructor() {
    super();
    // SWR list: first entry fetches, later entries serve cached + refresh.
    this.store.ensureList();

    // URL → detail. `selectedRouteId` is a computed signal so duplicate
    // paramMap emissions for the same id don't re-fire this. The store's
    // SWR cache renders a previously-visited person instantly while it
    // revalidates in the background; a never-seen id shows the loading
    // chrome. The effect is owned by the component's DestroyRef, so
    // teardown runs automatically on destroy.
    effect(() => {
      const id = this.selectedRouteId();
      this.store.setActiveDetailId(id ?? null);
      // Clear the per-face selection whenever the active person changes — a
      // selection keyed on the previous person's faces is meaningless once
      // we switch detail (or return to the list).
      this.faceBulk.clearSelection();
    });

    // Detail-panel thumbs prefetch eagerly — the visible-faces grid can be
    // large (up to ~60 visible cells), so paying the network cost up-front
    // keeps scroll snappy; the same pass covers the header + suggestion
    // avatars (#2078). Cover thumbs in the LIST grid stay gated by
    // (mapleVisibleOnce) to avoid N requests on first paint. Reads
    // `selected()` and `people()` inside the controller, so it re-runs when
    // either lands.
    effect(() => {
      this.detailCtl.prefetchDetailThumbs();
    });

    bindGridViewport(this.layout, this.peopleScrollContent);
  }

  /** Re-fetch the people list. Routes through the store's `invalidate()` so
   * the cached list stays on screen while the refresh lands — mutations that
   * change membership/counts (rename, assign, hide, delete, cluster) call
   * this so the list never shows stale data. */
  refresh(): void {
    this.store.invalidate();
  }

  selectPerson(id: string): void {
    void this.router.navigate(['/settings/people', id]);
  }

  /** Force a fresh fetch of an open person's detail (bypassing the SWR
   * cached value). Used after a mutation touches that person so the panel
   * reflects server state. */
  openDetail(id: string): void {
    this.store.invalidateDetail(id);
  }

  /** Re-fetch the open detail after a server-side mutation. If `id` matches
   * the current URL, the route signal won't re-fire the detail effect
   * (computed signals dedupe on equality), so invalidate the store entry
   * directly. Otherwise navigate; the effect picks it up and the store
   * serves the cached entry (if any) while revalidating. */
  private refetchDetail(id: string): void {
    if (this.selectedRouteId() === id) {
      this.store.invalidateDetail(id);
    } else {
      this.selectPerson(id);
    }
  }

  closeDetail(): void {
    void this.router.navigate(['/settings/people'], { replaceUrl: true });
  }

  // ── Rename / inline edit ────────────────────────────────────────────

  startEdit(person: { id: string; name: string }): void {
    this.editingId.set(person.id);
    this.draftName.set(person.name);
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.draftName.set('');
  }

  commitEdit(personId: string): void {
    const next = this.draftName().trim();
    if (next.length === 0) {
      this.cancelEdit();
      return;
    }
    const previous = this.people().find((p) => p.id === personId);
    if (previous && previous.name === next) {
      this.cancelEdit();
      return;
    }
    this.api.renamePerson(personId, next).subscribe({
      next: (result) => {
        this.editingId.set(null);
        this.draftName.set('');
        if (result.mergedFrom) {
          this.showToast(`Merged into ${result.name}`, 'success');
        }
        this.refresh();
        const open = this.selected();
        if (open && (open.id === personId || open.id === result.mergedFrom)) {
          this.refetchDetail(result.id);
        }
      },
      error: (err) => {
        this.showToast(errorMessage(err), 'error');
      },
    });
  }

  runClustering(): void {
    this.clusteringBusy.set(true);
    this.api.runClustering().subscribe({
      next: (result) => {
        this.clusteringBusy.set(false);
        this.showToast(clusteringSummary(result), 'success');
        this.refresh();
      },
      error: (err) => {
        this.clusteringBusy.set(false);
        this.showToast(errorMessage(err), 'error');
      },
    });
  }

  /** Soft-hide is reversible (Hidden page, restore anytime) and non-destructive
   * — faces stay grouped server-side — so this hides immediately and confirms
   * via toast rather than a blocking confirm() dialog. */
  async hidePerson(person: ApiPerson): Promise<void> {
    try {
      // Store's hidePerson flags the row hidden, evicts the cached detail, and
      // invalidates both lists so the person leaves the main list and lands on
      // the Hidden page. Faces stay grouped server-side (soft-hide, not delete).
      await this.store.hidePerson(person.id);
      this.showToast(`Hid ${person.name}`, 'success');
      if (this.selected()?.id === person.id) this.closeDetail();
    } catch (err) {
      this.showToast(errorMessage(err), 'error');
    }
  }

  /** Detail-header "Hide person" — same immediate hide + toast as {@link hidePerson}. */
  async hideSelectedCluster(): Promise<void> {
    const detail = this.selected();
    if (!detail) return;
    try {
      await this.store.hidePerson(detail.id);
      this.showToast(`Hid ${detail.name}`, 'success');
      this.closeDetail();
    } catch (err) {
      this.showToast(errorMessage(err), 'error');
    }
  }

  /** Exclude (#2894) is reversible (Excluded page, restore anytime) and
   * non-destructive — nothing on disk changes — but it's a bigger hammer
   * than hide: the person's photos leave search, the timeline, and every
   * other listing. Still toast-confirmed rather than dialog-blocked, for
   * the same reasons as {@link hidePerson}. */
  async excludeSelectedCluster(): Promise<void> {
    const detail = this.selected();
    if (!detail) return;
    try {
      await this.store.excludePerson(detail.id);
      this.showToast(`Excluded ${detail.name} — their photos will no longer appear`, 'success');
      this.closeDetail();
    } catch (err) {
      this.showToast(errorMessage(err), 'error');
    }
  }

  // ── Face-key helper ─────────────────────────────────────────────────
  // Shared `@for` track-by across the visible-faces grid and the
  // merge-suggestion "Compare faces" strip. Per-face selection + bulk
  // move/unassign/hide live in {@link faceBulk} (`PeopleFaceBulkController`).

  faceKey(face: { assetId: string; faceIndex: number }): string {
    return faceKey(face);
  }

  // ── Cover-thumb URL helpers ─────────────────────────────────────────

  detailCoverUrl(detail: ApiPersonDetail): string | null {
    const original = this.people().find((p) => p.id === detail.id);
    if (original) return this.coverThumbUrl(original);
    if (!detail.coverAssetId) return null;
    return this.thumbs.url(`apiId:${detail.coverAssetId}`);
  }

  suggestionCoverUrl(suggestion: ApiMergeSuggestion): string | null {
    const original = this.people().find((p) => p.id === suggestion.personId);
    if (original) return this.coverThumbUrl(original);
    if (!suggestion.coverAssetId) return null;
    return this.thumbs.url(`apiId:${suggestion.coverAssetId}`);
  }

  faceThumbUrl(face: ApiPersonFace): string | null {
    return this.thumbs.url(face.absPath);
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private showToast(text: string, tone: Tone): void {
    this.toastCtl.show(text, tone);
  }
}
