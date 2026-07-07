// SearchComponent — `/search` (auth-gated, Self-Hosted only).
//
// Structured search page over the Mongo-indexed library. State lives in URL
// query params so refresh / share / back-button all work. The component
// debounces typing (250 ms) before firing the request, and refetches facets
// on a 500 ms debounce — both batched into one request per change burst.
//
// Result thumbnails come from `FilesystemBrowseService.getThumbBlobUrl`
// (same blob-URL cache the browse grid uses), and clicking a result
// navigates to `/view/<id>` (the fast Preview surface, Web Preview Surface
// Task 6c). Self-Hosted search returns `fs:<absPath>` ids, which
// `PreviewShellComponent` resolves via the self-hosted-synth path.
//
// Pure derivation (param coercion, CSV-set plumbing, active-filter
// predicate, date-preset math, `currentParams` builder, label helpers,
// result → view-model adapter, option tables) lives next door in
// `./search.vm.ts`. This file owns DI, signal wiring, route effects,
// debounce timers, request fan-out, and the thumb-cache side effects.

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute, Params, Router } from '@angular/router';
import { SlicePipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { firstValueFrom, Subscription } from 'rxjs';
import {
  ApiFolder,
  AssetMetadataSnapshot,
  BatchMetadataPanelComponent,
  BatchMetadataService,
  BunApiBackendService,
  FilesystemBrowseService,
  MapleIconComponent,
  SearchFacets,
  SearchParams,
  SearchResponse,
  SearchResult,
  SearchSceneType,
  SearchService,
  SearchSort,
  errorMessage,
  viewRouteCommands,
} from '@maple-common';
import {
  COLOR_LABELS,
  ColorValue,
  FlagValue,
  HIDDEN_OPTIONS,
  HiddenValue,
  PAGE_SIZE,
  PresetKind,
  ResultViewModel,
  SCENE_TYPE_OPTIONS,
  SORT_OPTIONS,
  ScreenshotValue,
  buildSearchParams,
  cameraLabel,
  hasActiveFilters,
  numOrEmpty,
  numString,
  parseColor,
  parseCsvSet,
  parseFlag,
  parseHidden,
  parseRating,
  parseSceneType,
  parseScreenshot,
  parseSort,
  presetDateRange,
  sceneTypeCount,
  sortLabel,
  toResultViewModel,
  toggleCsv,
} from './search.vm';

@Component({
  standalone: true,
  selector: 'maple-search',
  imports: [MapleIconComponent, SlicePipe, BatchMetadataPanelComponent],
  templateUrl: './search.component.html',
  styleUrl: './search.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(BunApiBackendService);
  private readonly fs = inject(FilesystemBrowseService);
  private readonly search = inject(SearchService);
  private readonly batchMetadataService = inject(BatchMetadataService);

  // ── URL → params signal ──────────────────────────────────────────────────
  // Single source of truth. UI reads from these signals, mutations write to
  // the URL via `patchQueryParams`, and the URL → signal flow re-fires the
  // search request through an effect.
  private readonly query = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });

  readonly q = computed(() => this.query()?.get('q') ?? '');
  readonly libraryId = computed(() => this.query()?.get('libraryId') ?? '');
  readonly camera = computed(() => this.query()?.get('camera') ?? '');
  readonly lens = computed(() => this.query()?.get('lens') ?? '');
  readonly isoMin = computed(() => numOrEmpty(this.query()?.get('isoMin')));
  readonly isoMax = computed(() => numOrEmpty(this.query()?.get('isoMax')));
  readonly apertureMin = computed(() => numOrEmpty(this.query()?.get('apertureMin')));
  readonly apertureMax = computed(() => numOrEmpty(this.query()?.get('apertureMax')));
  readonly focalMin = computed(() => numOrEmpty(this.query()?.get('focalMin')));
  readonly focalMax = computed(() => numOrEmpty(this.query()?.get('focalMax')));
  readonly from = computed(() => this.query()?.get('from') ?? '');
  readonly to = computed(() => this.query()?.get('to') ?? '');
  readonly rating = computed(() => parseRating(this.query()?.get('rating')));
  readonly flag = computed<FlagValue>(() => parseFlag(this.query()?.get('flag')));
  readonly color = computed<ColorValue>(() => parseColor(this.query()?.get('color')));
  readonly extSelectedCsv = computed(() => this.query()?.get('ext') ?? '');
  readonly sceneType = computed<SearchSceneType>(() =>
    parseSceneType(this.query()?.get('sceneType')),
  );
  readonly activity = computed(() => this.query()?.get('activity') ?? '');
  readonly subjectsCsv = computed(() => this.query()?.get('subjects') ?? '');
  /** Tri-state screenshot filter: `''` (Any), `'true'` (Screenshots only),
   * `'false'` (Photos only). Stored as the literal query-param value so
   * the URL round-trips cleanly. */
  readonly isScreenshot = computed<ScreenshotValue>(() =>
    parseScreenshot(this.query()?.get('isScreenshot')),
  );
  readonly hidden = computed<HiddenValue>(() => parseHidden(this.query()?.get('hidden')));
  readonly sort = computed<SearchSort>(() => parseSort(this.query()?.get('sort')));

  /** Set of selected extensions, parsed from the comma-separated `ext` param. */
  readonly extSelected = computed<Set<string>>(() =>
    parseCsvSet(this.extSelectedCsv(), { lower: true }),
  );

  /** Set of selected vision subjects, parsed from the comma-separated `subjects` param. */
  readonly subjectsSelected = computed<Set<string>>(() => parseCsvSet(this.subjectsCsv()));

  /** Local q input (may differ from the URL while the debounce is running). */
  readonly qInput = signal<string>('');

  // ── Async data ───────────────────────────────────────────────────────────
  readonly folders = signal<ApiFolder[]>([]);
  readonly facets = signal<SearchFacets | null>(null);
  readonly results = signal<ResultViewModel[]>([]);
  readonly total = signal<number>(0);
  readonly page = signal<number>(0);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  readonly selectedIds = signal<ReadonlySet<string>>(new Set());
  readonly batchMetaDialogVisible = signal(false);
  readonly batchMetaAssetSnapshots = signal<AssetMetadataSnapshot[]>([]);

  readonly selectedCount = computed(() => this.selectedIds().size);

  // ── Derived view-model bits ──────────────────────────────────────────────
  readonly sortOptions = SORT_OPTIONS;
  readonly colorOptions = COLOR_LABELS;
  readonly sceneTypeOptions = SCENE_TYPE_OPTIONS;
  readonly hiddenOptions = HIDDEN_OPTIONS;
  readonly stars = [1, 2, 3, 4, 5];

  /** True when any structured filter (i.e. anything besides q) is set. */
  readonly hasActiveFilters = computed(() => hasActiveFilters(this.query() ?? null));

  readonly canLoadMore = computed(() => this.results().length < this.total() && !this.loading());

  readonly sortLabel = computed(() => sortLabel(this.sort()));

  // Template-binding shims so the HTML keeps calling `cameraLabel(c)` and
  // `sceneTypeCount(v)` unchanged after the VM extraction.
  protected readonly cameraLabel = cameraLabel;
  protected readonly sceneTypeCountFor = (value: string): number | null =>
    sceneTypeCount(this.facets(), value);

  // ── Debounce timers + generation guards ──────────────────────────────────
  /** Debounces q-input keystrokes → URL updates (250 ms). Separate from the
   * request-fire timer so an in-flight URL update isn't cancelled when the
   * URL → effect re-arms the request timer. */
  private qInputDebounce: ReturnType<typeof setTimeout> | null = null;
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;
  private facetsDebounce: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every search request — late responses with a stale gen are
   * dropped on the floor so a slow first request can't overwrite a fast
   * second one. */
  private searchGen = 0;
  private facetsGen = 0;

  /** Cache of `abs_path → blob:` thumbnail URL. Created blob URLs are revoked
   * via the FilesystemBrowseService on sign-out; on this page we let them
   * live for the duration so back-nav restores instantly. */
  private thumbCache = new Map<string, string>();

  /** Cache of serialized search params → response. Re-issuing an identical
   * page-0 query (filter round-trips, the URL effect re-firing) serves from
   * here instead of re-hitting the network. Lives for the page session. */
  private searchCache = new Map<string, SearchResponse>();

  /** In-flight `fetchSnapshots` subscription for the batch metadata panel.
   * Torn down on re-invocation and on dismiss (mirrors
   * `browse-shell.component.ts`'s `onEditMetadata`/`onBatchMetaDismiss`) so a
   * rapid double-click can't race two fetches into `batchMetaAssetSnapshots`. */
  private fetchSnapshotsSub: Subscription | null = null;

  constructor() {
    // URL → request. Refires whenever the query map changes. Sync the qInput
    // signal to the URL value when it changes externally (e.g. cleared via
    // "Clear all" or navigated in via the toolbar with ?q=…).
    effect(() => {
      const m = this.query();
      if (!m) return;
      const urlQ = m.get('q') ?? '';
      // Read/write qInput untracked so a user keystroke (which sets qInput)
      // can't re-fire this effect and clobber the in-progress text with the
      // not-yet-debounced URL value. The effect only reacts to URL changes.
      untracked(() => {
        if (urlQ !== this.qInput()) this.qInput.set(urlQ);
      });
      this.clearSelection();
      this.scheduleSearch();
      this.scheduleFacets();
    });
  }

  async ngOnInit(): Promise<void> {
    // Library scope dropdown — fetch once on mount.
    try {
      const list = await firstValueFrom(this.api.listFolders());
      this.folders.set(list);
    } catch {
      // Non-fatal: leaving folders empty just hides the dropdown options.
      this.folders.set([]);
    }
  }

  ngOnDestroy(): void {
    if (this.qInputDebounce !== null) clearTimeout(this.qInputDebounce);
    if (this.searchDebounce !== null) clearTimeout(this.searchDebounce);
    if (this.facetsDebounce !== null) clearTimeout(this.facetsDebounce);
    this.fetchSnapshotsSub?.unsubscribe();
  }

  // ── URL helpers ──────────────────────────────────────────────────────────
  private currentParams(): SearchParams {
    return buildSearchParams({
      q: this.q(),
      libraryId: this.libraryId(),
      camera: this.camera(),
      lens: this.lens(),
      isoMin: this.isoMin(),
      isoMax: this.isoMax(),
      apertureMin: this.apertureMin(),
      apertureMax: this.apertureMax(),
      focalMin: this.focalMin(),
      focalMax: this.focalMax(),
      from: this.from(),
      to: this.to(),
      rating: this.rating(),
      flag: this.flag(),
      color: this.color(),
      extCsv: this.extSelectedCsv(),
      sceneType: this.sceneType(),
      activity: this.activity(),
      subjects: this.subjectsSelected(),
      isScreenshot: this.isScreenshot(),
      hidden: this.hidden(),
      sort: this.sort(),
    });
  }

  private patchQueryParams(patch: Params): void {
    // Convert "" values to undefined so they're stripped from the URL.
    const clean: Params = {};
    for (const [k, v] of Object.entries(patch)) {
      clean[k] = v === '' || v === null || v === undefined ? null : v;
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: clean,
      queryParamsHandling: 'merge',
      replaceUrl: false,
    });
  }

  // ── Top bar actions ──────────────────────────────────────────────────────
  onQInput(e: Event): void {
    this.qInput.set((e.target as HTMLInputElement).value);
    // Push to the URL after a short debounce so each keystroke doesn't
    // overflow the back-stack. The URL → effect fires the request itself.
    if (this.qInputDebounce !== null) clearTimeout(this.qInputDebounce);
    this.qInputDebounce = setTimeout(() => {
      this.patchQueryParams({ q: this.qInput().trim(), page: null });
    }, 250);
  }

  onLibraryChange(e: Event): void {
    const value = (e.target as HTMLSelectElement).value;
    this.patchQueryParams({ libraryId: value, page: null });
  }

  onSortChange(e: Event): void {
    const value = (e.target as HTMLSelectElement).value as SearchSort;
    this.patchQueryParams({ sort: value, page: null });
  }

  clearAll(): void {
    void this.router.navigate(['/search']);
    this.qInput.set('');
  }

  // ── Filter sidebar actions ───────────────────────────────────────────────
  setCamera(value: string): void {
    this.patchQueryParams({ camera: value, page: null });
  }

  setLens(value: string): void {
    this.patchQueryParams({ lens: value, page: null });
  }

  setIsoMin(e: Event): void {
    this.patchQueryParams({ isoMin: numString(e), page: null });
  }
  setIsoMax(e: Event): void {
    this.patchQueryParams({ isoMax: numString(e), page: null });
  }
  setApertureMin(e: Event): void {
    this.patchQueryParams({ apertureMin: numString(e), page: null });
  }
  setApertureMax(e: Event): void {
    this.patchQueryParams({ apertureMax: numString(e), page: null });
  }
  setFocalMin(e: Event): void {
    this.patchQueryParams({ focalMin: numString(e), page: null });
  }
  setFocalMax(e: Event): void {
    this.patchQueryParams({ focalMax: numString(e), page: null });
  }
  setFrom(e: Event): void {
    this.patchQueryParams({ from: (e.target as HTMLInputElement).value, page: null });
  }
  setTo(e: Event): void {
    this.patchQueryParams({ to: (e.target as HTMLInputElement).value, page: null });
  }

  setRating(n: number): void {
    const next = this.rating() === n ? 0 : n;
    this.patchQueryParams({ rating: next > 0 ? next : null, page: null });
  }

  setFlag(value: FlagValue): void {
    this.patchQueryParams({ flag: value, page: null });
  }

  setColor(value: ColorValue): void {
    this.patchQueryParams({ color: value, page: null });
  }

  toggleExt(value: string): void {
    const csv = toggleCsv(this.extSelectedCsv(), value);
    this.patchQueryParams({ ext: csv, page: null });
  }

  setSceneType(value: SearchSceneType): void {
    this.patchQueryParams({ sceneType: value, page: null });
  }

  setActivity(value: string): void {
    this.patchQueryParams({ activity: value, page: null });
  }

  toggleSubject(value: string): void {
    const csv = toggleCsv(this.subjectsCsv(), value);
    this.patchQueryParams({ subjects: csv, page: null });
  }

  setIsScreenshot(value: ScreenshotValue): void {
    this.patchQueryParams({ isScreenshot: value, page: null });
  }

  setHidden(value: HiddenValue): void {
    this.patchQueryParams({ hidden: value || null, page: null });
  }

  /** Quick date presets — write the from/to params directly. */
  preset(kind: PresetKind): void {
    const { from, to } = presetDateRange(kind, new Date());
    this.patchQueryParams({ from, to, page: null });
  }

  // ── Search + facets requests (debounced) ─────────────────────────────────
  private scheduleSearch(): void {
    if (this.searchDebounce !== null) clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => this.runSearch(/*append*/ false), 250);
  }

  private scheduleFacets(): void {
    if (this.facetsDebounce !== null) clearTimeout(this.facetsDebounce);
    this.facetsDebounce = setTimeout(() => this.runFacets(), 500);
  }

  private async runSearch(append: boolean): Promise<void> {
    const gen = ++this.searchGen;
    const page = append ? this.page() + 1 : 0;
    const params: SearchParams = { ...this.currentParams(), page, limit: PAGE_SIZE };
    const key = JSON.stringify(params);

    // Serve an identical (non-append) query from cache — bumping searchGen
    // above already supersedes any in-flight request, so no network round-trip.
    if (!append) {
      const cached = this.searchCache.get(key);
      if (cached) {
        this.error.set(null);
        this.loading.set(false);
        this.applyResults(cached, false);
        return;
      }
    }

    this.loading.set(true);
    this.error.set(null);
    try {
      const r = await firstValueFrom(this.search.search(params));
      if (gen !== this.searchGen) return; // a newer request superseded us
      this.searchCache.set(key, r);
      this.applyResults(r, append);
    } catch (e: unknown) {
      if (gen !== this.searchGen) return;
      this.error.set(errorMessage(e));
      if (!append) this.results.set([]);
    } finally {
      if (gen === this.searchGen) this.loading.set(false);
    }
  }

  /** Apply a search response to the result signals and kick off thumb loads.
   * Shared by the cache-hit and network paths. */
  private applyResults(r: SearchResponse, append: boolean): void {
    this.total.set(r.total);
    this.page.set(r.page);
    const vms = r.results.map((res) => this.toViewModel(res));
    this.results.update((prev) => (append ? prev.concat(vms) : vms));
    // Kick off thumb loads (fire-and-forget).
    for (const vm of vms) void this.loadThumb(vm);
  }

  private async runFacets(): Promise<void> {
    const gen = ++this.facetsGen;
    try {
      const f = await firstValueFrom(this.search.facets(this.currentParams()));
      if (gen !== this.facetsGen) return;
      this.facets.set(f);
    } catch {
      if (gen !== this.facetsGen) return;
      this.facets.set(null);
    }
  }

  loadMore(): void {
    if (!this.canLoadMore()) return;
    void this.runSearch(/*append*/ true);
  }

  // ── Result thumbnails ────────────────────────────────────────────────────
  private toViewModel(r: SearchResult): ResultViewModel {
    return toResultViewModel(r, this.thumbCache.get(r.abs_path) ?? null);
  }

  private async loadThumb(vm: ResultViewModel): Promise<void> {
    if (vm.thumbUrl) return;
    try {
      const url = await this.fs.getThumbBlobUrl(vm.abs_path, 512);
      this.thumbCache.set(vm.abs_path, url);
      this.results.update((list) =>
        list.map((r) =>
          r.abs_path === vm.abs_path ? { ...r, thumbUrl: url, thumbLoading: false } : r,
        ),
      );
    } catch {
      this.results.update((list) =>
        list.map((r) => (r.abs_path === vm.abs_path ? { ...r, thumbLoading: false } : r)),
      );
    }
  }

  // ── Result clicks → Preview ───────────────────────────────────────────────
  openResult(r: ResultViewModel): void {
    void this.router.navigate(viewRouteCommands(r.id));
  }

  // ── Selection ─────────────────────────────────────────────────────────────
  toggleSelect(id: string): void {
    this.selectedIds.update((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  selectAllLoaded(): void {
    this.selectedIds.set(new Set(this.results().map((r) => r.id)));
  }

  clearSelection(): void {
    this.selectedIds.set(new Set());
  }

  // ── Batch metadata dialog ────────────────────────────────────────────────
  onEditMetadata(): void {
    const ids = this.selectedIds();
    const addresses = this.results()
      .filter((r) => ids.has(r.id))
      .map((r) => r.address)
      .filter((a): a is string => a !== null);
    if (addresses.length === 0) return;

    this.fetchSnapshotsSub?.unsubscribe();
    this.fetchSnapshotsSub = this.batchMetadataService.fetchSnapshots(addresses).subscribe({
      next: (snapshots) => {
        this.batchMetaAssetSnapshots.set(snapshots);
        this.batchMetaDialogVisible.set(true);
      },
      error: () => {
        this.error.set('Could not load metadata for the selected results.');
      },
    });
  }

  onBatchMetaDismiss(): void {
    this.fetchSnapshotsSub?.unsubscribe();
    this.fetchSnapshotsSub = null;
    this.batchMetaDialogVisible.set(false);
    this.batchMetaAssetSnapshots.set([]);
    this.clearSelection();
    // Editing metadata (e.g. toggling `hidden`) doesn't change any URL/search
    // param, so `runSearch`'s cache key is identical before and after the
    // edit — clear it so the post-dismiss refresh actually re-fetches instead
    // of replaying the stale, pre-edit cached response.
    this.searchCache.clear();
    void this.runSearch(/*append*/ false);
  }

  // ── Template helpers ─────────────────────────────────────────────────────
  trackResult = (_: number, r: ResultViewModel) => r.id;
  trackExt = (_: number, e: { value: string }) => e.value;
  trackFacetValue = (_: number, e: { value: string }) => e.value;

  /** Shim retained for template compatibility; delegates to the VM helper
   * bound to the current `facets()` snapshot. */
  sceneTypeCount(value: string): number | null {
    return sceneTypeCount(this.facets(), value);
  }

  retry(): void {
    this.error.set(null);
    void this.runSearch(false);
  }
}
