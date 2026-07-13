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
import { firstValueFrom } from 'rxjs';
import {
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
import { FaceThumbCrop } from './face-thumb-crop';
import {
  TOAST_TTL_MS,
  Toast,
  Tone,
  averageConfidence,
  bulkFailureLabel,
  bulkSuccessLabel,
  chunkPeopleRows,
  clusteringSummary,
  errorMessage,
  faceKey,
  filterNamed,
  hiddenFaceCount,
  hidePersonConfirm,
  isAutoNamed,
  PEOPLE_GRID,
  peopleCardWidth,
  peopleGridColumns,
  peopleRowHeight,
  peopleRowKey,
  peopleStats,
  pickSelectedFaces,
  selectAllKeys,
  sortPeople,
  toggleSelection,
  visibleFaces,
} from './people.vm';
import { PeopleBulkController } from './people-bulk.controller';
import { PeopleDetailController } from './people-detail.controller';

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
export class PeopleComponent implements OnDestroy {
  private readonly api = inject(BunApiBackendService);
  private readonly fsBrowse = inject(FilesystemBrowseService);
  private readonly librarySource: LibrarySource = inject(LIBRARY_SOURCE);
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

  readonly toast = signal<Toast | null>(null);

  /** Per-face selection set for bulk actions. Keyed by `assetId:faceIndex`
   * so we can intersect with the detail's faces list cleanly. */
  readonly selectedFaces = signal<ReadonlySet<string>>(new Set());

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

  /** Detail-view face actions: set-as-cover, open-in-editor, infinite scroll. */
  readonly detailCtl = new PeopleDetailController({
    store: this.store,
    router: this.router,
    selected: this.selected,
    selectedFaces: this.selectedFaces,
    clearSelection: () => this.clearSelection(),
    bulkBusy: this.bulkBusy,
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
  private readonly peopleScrollContent = viewChild<ElementRef<HTMLElement>>('peopleScrollContent');

  /** Measured inner width of the viewport. Seeded until the ResizeObserver
   * reports the real width. */
  private readonly containerWidth = signal<number>(900);

  /** Min card width — denser on narrow (phone) viewports, matching the old
   * responsive `minmax(140px|180px, 1fr)` CSS. */
  private readonly minCardWidth = computed(() => (this.containerWidth() <= 767 ? 140 : 180));

  readonly gridColumns = computed(() =>
    peopleGridColumns(this.containerWidth(), this.minCardWidth()),
  );

  /** Square card side (px) for the current column count + container width. */
  readonly cardWidth = computed(() => peopleCardWidth(this.containerWidth(), this.gridColumns()));

  /** Fixed row height fed to the viewport `itemSize`. */
  readonly rowHeight = computed(() => peopleRowHeight(this.cardWidth()));

  /** Inter-card gap + per-row bottom margin (px). One source of truth shared
   * with the packing math (`peopleRowHeight` adds one `GAP`/row). */
  protected readonly gridGap = PEOPLE_GRID.GAP;

  /** Sorted people packed into fixed-width rows for the virtual viewport. */
  readonly peopleRows = computed(() => chunkPeopleRows(this.sortedPeople(), this.gridColumns()));

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

  /** Bearer-gated thumbnail blob cache. See {@link ThumbBlobCache} for
   * lifecycle / cache-key rules. Created once per component instance. */
  private readonly thumbs = new ThumbBlobCache(this.api, this.fsBrowse, this.librarySource);

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
      this.selectedFaces.set(new Set());
    });

    // Detail-panel face thumbs prefetch eagerly — the visible-faces grid
    // can be large (up to ~60 visible cells), so paying the network cost
    // up-front keeps scroll snappy. Cover thumbs in the LIST grid are
    // gated by (mapleVisibleOnce) to avoid N requests on first paint.
    effect(() => {
      const detail = this.selected();
      if (!detail) return;
      for (const f of detail.faces) {
        this.thumbs.ensure(f.absPath, null, f.absPath, f.assetId);
      }
    });

    // Re-target the ResizeObserver each time the virtual-scroll viewport
    // appears. It lives in conditional template blocks (only the populated
    // list view renders it), so a signal-query effect catches first paint and
    // back-navigation alike. `onCleanup` disconnects when the viewport goes
    // away (the detail view removes it from the DOM) so a detached element
    // isn't observed/retained until destroy; the effect re-attaches when the
    // query resolves to a fresh element again.
    effect((onCleanup) => {
      const ref = this.peopleScrollContent();
      if (!ref) return;
      this.observeViewport(ref.nativeElement);
      onCleanup(() => this.resizeObserver?.disconnect());
    });
  }

  /** ResizeObserver on the viewport content so the column count + card/row
   * sizes track the container width. Re-targeted by the constructor effect. */
  private resizeObserver?: ResizeObserver;

  /** (Re)attach the ResizeObserver to the current viewport host and seed the
   * width immediately. Disconnects any prior observer first. */
  private observeViewport(host: HTMLElement): void {
    this.containerWidth.set(host.clientWidth || 900);
    if (typeof ResizeObserver === 'undefined') return; // SSR / very old browser
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const e of entries) this.containerWidth.set(e.contentRect.width);
    });
    this.resizeObserver.observe(host);
  }

  ngOnDestroy(): void {
    this.thumbs.destroy();
    this.resizeObserver?.disconnect();
  }

  ensureCoverThumb(p: ApiPerson): void {
    const key = ThumbBlobCache.coverKey(p);
    if (key) this.thumbs.ensure(key, p.coverAddress ?? null, p.coverAbsPath, p.coverAssetId);
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

  async hidePerson(person: ApiPerson): Promise<void> {
    const ok = confirm(hidePersonConfirm(person.name, person.faceCount));
    if (!ok) return;
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

  /** Detail-header "Hide person" — confirms against the open detail. */
  async hideSelectedCluster(): Promise<void> {
    const detail = this.selected();
    if (!detail) return;
    const matching = this.people().find((p) => p.id === detail.id);
    const faceCount = matching?.faceCount ?? detail.faces.length;
    const ok = confirm(hidePersonConfirm(detail.name, faceCount));
    if (!ok) return;
    try {
      await this.store.hidePerson(detail.id);
      this.showToast(`Hid ${detail.name}`, 'success');
      this.closeDetail();
    } catch (err) {
      this.showToast(errorMessage(err), 'error');
    }
  }

  // ── Face selection (bulk) ───────────────────────────────────────────

  faceKey(face: { assetId: string; faceIndex: number }): string {
    return faceKey(face);
  }

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
    this.selectedFaces.set(selectAllKeys(this.visibleFaces()));
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
    const faces = pickSelectedFaces(this.selected(), this.selectedFaces());
    if (faces.length === 0) return;
    this.bulkBusy.update((n) => n + 1);
    try {
      const results = await Promise.allSettled(faces.map(fn));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;

      if (ok > 0) {
        this.showToast(bulkSuccessLabel(verb, ok), 'success');
      }
      if (failed > 0) {
        const firstReject = results.find(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        const reason = firstReject ? errorMessage(firstReject.reason) : 'unknown error';
        this.showToast(bulkFailureLabel(failed, reason), 'error');
      }
    } finally {
      // Always clear selection + refresh, even on partial / total failure
      // — the server state for the successful faces moved, so leaving the
      // UI alone would lie about what's where.
      this.clearSelection();
      const open = this.selected();
      if (open) this.openDetail(open.id);
      this.refresh();
      this.bulkBusy.update((n) => Math.max(0, n - 1));
    }
  }

  bulkMoveTo(personId: string): Promise<void> {
    const target = personId.trim();
    if (!target) return Promise.resolve();
    return this.bulkApply('Moved', (f) =>
      firstValueFrom(this.api.assignFaceToPerson(f.assetId, f.faceIndex, target)),
    );
  }

  bulkUnassign(): Promise<void> {
    return this.bulkApply('Unassigned', (f) =>
      firstValueFrom(this.api.assignFaceToPerson(f.assetId, f.faceIndex, null)),
    );
  }

  bulkHide(): Promise<void> {
    return this.bulkApply('Hid', (f) => firstValueFrom(this.api.hideFace(f.assetId, f.faceIndex)));
  }

  // ── Cover-thumb URL helpers ─────────────────────────────────────────

  coverThumbUrl(person: ApiPerson): string | null {
    return this.thumbs.url(ThumbBlobCache.coverKey(person));
  }

  detailCoverUrl(detail: ApiPersonDetail): string | null {
    const original = this.people().find((p) => p.id === detail.id);
    if (original) return this.coverThumbUrl(original);
    if (!detail.coverAssetId) return null;
    return this.thumbs.url(`apiId:${detail.coverAssetId}`);
  }

  faceThumbUrl(face: ApiPersonFace): string | null {
    return this.thumbs.url(face.absPath);
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private showToast(text: string, tone: Tone): void {
    this.toast.set({ text, tone });
    setTimeout(() => {
      const cur = this.toast();
      if (cur && cur.text === text) this.toast.set(null);
    }, TOAST_TTL_MS);
  }
}
