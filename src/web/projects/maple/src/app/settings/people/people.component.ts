// PeopleComponent — `/settings/people` (auth + owner-gated).
//
// Operator surface for the face-cluster identities ("People"), wrapped in
// the shared SettingsShell so it lives alongside Account / Workers / Users.
// `selected()` is the URL-driven detail state — when set, the page renders
// a full-width detail view (header + filter bar + face grid + floating
// selection toolbar) that replaces the list view entirely. When null, the
// list view renders as `<maple-people-list>` (page header, stats line +
// small-cluster toggle, empty states, virtual-scroll card grid — see
// `people-list.component.ts`, split out in #2140).
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
// {@link PeopleBulkController} (co-located, shared with `PeopleListComponent`
// as the SAME instance). Bearer-gated thumb loading lives in
// {@link ThumbBlobCache}. Pure derivation lives in `./people.vm.ts`. This
// file owns DI, signal wiring, and side effects.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import {
  ApiMergeSuggestion,
  ApiPerson,
  ApiPersonDetail,
  ApiPersonFace,
  ApiRenameResult,
  BunApiBackendService,
  FilesystemBrowseService,
  LIBRARY_SOURCE,
  type LibrarySource,
  PeopleStore,
  MuiButtonComponent,
} from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';
import { SettingsIconComponent } from '../settings-icon.component';
import { MapleVisibleOnceDirective } from './visible-once.directive';
import { ThumbBlobCache } from './thumb-blob-cache';
import { PeopleGridHost, createToast } from './people-grid-layout';
import { FaceThumbCrop } from './face-thumb-crop';
import { PeopleListComponent } from './people-list.component';
import {
  TOAST_TTL_MS,
  Toast,
  Tone,
  averageConfidence,
  clusteringSummary,
  errorMessage,
  faceKey,
  filterNamed,
  hiddenFaceCount,
  isAutoNamed,
  sortPeople,
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
    SettingsShellComponent,
    SettingsIconComponent,
    MapleVisibleOnceDirective,
    MuiButtonComponent,
    PeopleListComponent,
  ],
  templateUrl: './people.component.html',
  styleUrl: './people.component.scss',
  host: { class: 'set-vars set-page-host w-full' },
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

  readonly sortedPeople = computed(() => sortPeople(this.people()));

  readonly namedPeople = computed(() => filterNamed(this.sortedPeople()));

  /** Bulk list-selection / merge / hide controller. Declared after `store`,
   * `router`, `people`, `namedPeople`, and `selected` so field initializers
   * that reference those are already resolved. Shared with
   * `PeopleListComponent` (bound via `[bulk]`) — the SAME instance, so its
   * detail-view merge picker and the list view's selection stay coherent. */
  readonly bulk = new PeopleBulkController({
    store: this.store,
    router: this.router,
    people: this.people,
    namedPeople: this.namedPeople,
    selected: this.selected,
    toast: (text, tone) => this.showToast(text, tone),
  });

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

  /** Face-thumbnail crop-transform state (natural-dims capture + transform).
   * Shared by `PeopleListComponent`'s cover thumbs (bound via `[crop]`) and
   * the detail face grid — one cache for both views. */
  protected readonly crop = new FaceThumbCrop();

  /** Bound wrappers for the inherited `PeopleGridHost` methods, passed down
   * to `PeopleListComponent` as plain functions so it shares this
   * component's single `ThumbBlobCache` rather than owning its own. Arrow
   * functions capture `this` lexically, so the binding survives being
   * passed as a value across the component boundary. */
  protected readonly coverThumbUrlFn = (p: ApiPerson): string | null => this.coverThumbUrl(p);
  protected readonly ensureCoverThumbFn = (p: ApiPerson): void => this.ensureCoverThumb(p);

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
        this.refetchDetailIfOpen(personId, result);
      },
      error: (err) => {
        this.showToast(errorMessage(err), 'error');
      },
    });
  }

  /** Re-fetch the open detail panel after a rename/merge, but only if the
   * open person is the one that just changed — either the renamed person
   * itself, or (on a server-side merge) the person it got merged away from.
   * Split out of {@link commitEdit}'s response handler purely to keep that
   * handler's own branch count low. */
  private refetchDetailIfOpen(personId: string, result: ApiRenameResult): void {
    const open = this.selected();
    if (!open) return;
    if (open.id !== personId && open.id !== result.mergedFrom) return;
    this.refetchDetail(result.id);
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
