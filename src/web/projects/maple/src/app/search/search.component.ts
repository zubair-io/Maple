// SearchComponent — `/search` (auth-gated, Self-Hosted only).
//
// Structured search page over the Mongo-indexed library. State lives in URL
// query params so refresh / share / back-button all work. The component
// debounces typing (250 ms) before firing the request, and refetches facets
// on a 500 ms debounce — both batched into one request per change burst.
//
// Result thumbnails come from `FilesystemBrowseService.getThumbBlobUrl`
// (same blob-URL cache the browse grid uses), and clicking a result
// navigates to `/edit/<fs:abs_path>` — that id matches the editor's
// cold-load contract from filesystem-browse.

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Params, Router } from '@angular/router';
import { SlicePipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import {
  ApiFolder,
  BunApiBackendService,
  FilesystemBrowseService,
  MapleIconComponent,
  SearchFacets,
  SearchParams,
  SearchResult,
  SearchService,
  SearchSort,
} from '@maple-common';

const PAGE_SIZE = 100;

const SORT_LABEL: Record<SearchSort, string> = {
  captured_desc: 'Newest first',
  captured_asc: 'Oldest first',
  name: 'Name',
  rating: 'Rating',
};

const COLOR_LABELS: Array<{ value: '' | 'red' | 'yellow' | 'green' | 'blue' | 'purple'; label: string; swatch: string }> = [
  { value: '', label: 'Any', swatch: 'transparent' },
  { value: 'red', label: 'Red', swatch: '#e11d48' },
  { value: 'yellow', label: 'Yellow', swatch: '#eab308' },
  { value: 'green', label: 'Green', swatch: '#22c55e' },
  { value: 'blue', label: 'Blue', swatch: '#3b82f6' },
  { value: 'purple', label: 'Purple', swatch: '#a855f7' },
];

interface ResultViewModel extends SearchResult {
  thumbUrl: string | null;
  thumbLoading: boolean;
}

@Component({
  standalone: true,
  selector: 'maple-search',
  imports: [MapleIconComponent, SlicePipe],
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
  readonly rating = computed(() => Number(this.query()?.get('rating') ?? '0'));
  readonly flag = computed(() => (this.query()?.get('flag') ?? '') as '' | 'pick' | 'reject' | 'none');
  readonly color = computed(
    () => (this.query()?.get('color') ?? '') as '' | 'red' | 'yellow' | 'green' | 'blue' | 'purple',
  );
  readonly extSelectedCsv = computed(() => this.query()?.get('ext') ?? '');
  readonly sort = computed<SearchSort>(
    () => (this.query()?.get('sort') as SearchSort) || 'captured_desc',
  );

  /** Set of selected extensions, parsed from the comma-separated `ext` param. */
  readonly extSelected = computed<Set<string>>(() => {
    const csv = this.extSelectedCsv();
    if (!csv) return new Set();
    return new Set(csv.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  });

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

  // ── Derived view-model bits ──────────────────────────────────────────────
  readonly sortOptions: ReadonlyArray<{ value: SearchSort; label: string }> = (
    Object.entries(SORT_LABEL) as Array<[SearchSort, string]>
  ).map(([value, label]) => ({ value, label }));
  readonly colorOptions = COLOR_LABELS;
  readonly stars = [1, 2, 3, 4, 5];

  /** True when any structured filter (i.e. anything besides q) is set. */
  readonly hasActiveFilters = computed(() => {
    const m = this.query();
    if (!m) return false;
    for (const k of m.keys) {
      if (k === 'q' || k === 'sort' || k === 'page' || k === 'limit') continue;
      const v = m.get(k);
      if (v && v.length > 0) return true;
    }
    return false;
  });

  readonly canLoadMore = computed(
    () => this.results().length < this.total() && !this.loading(),
  );

  readonly sortLabel = computed(() => SORT_LABEL[this.sort()] ?? this.sort());

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

  constructor() {
    // URL → request. Refires whenever the query map changes. Sync the qInput
    // signal to the URL value when it changes externally (e.g. cleared via
    // "Clear all" or navigated in via the toolbar with ?q=…).
    effect(() => {
      const m = this.query();
      if (!m) return;
      const urlQ = m.get('q') ?? '';
      if (urlQ !== this.qInput()) this.qInput.set(urlQ);
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
  }

  // ── URL helpers ──────────────────────────────────────────────────────────
  private currentParams(): SearchParams {
    return {
      q: this.q() || undefined,
      libraryId: this.libraryId() || undefined,
      camera: this.camera() || undefined,
      lens: this.lens() || undefined,
      isoMin: this.isoMin() ?? undefined,
      isoMax: this.isoMax() ?? undefined,
      apertureMin: this.apertureMin() ?? undefined,
      apertureMax: this.apertureMax() ?? undefined,
      focalMin: this.focalMin() ?? undefined,
      focalMax: this.focalMax() ?? undefined,
      from: this.from() || undefined,
      to: this.to() || undefined,
      rating: this.rating() > 0 ? this.rating() : undefined,
      flag: (this.flag() || undefined) as 'pick' | 'reject' | 'none' | undefined,
      color: this.color() || undefined,
      ext: this.extSelectedCsv() || undefined,
      sort: this.sort(),
    };
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

  setFlag(value: '' | 'pick' | 'reject' | 'none'): void {
    this.patchQueryParams({ flag: value, page: null });
  }

  setColor(value: '' | 'red' | 'yellow' | 'green' | 'blue' | 'purple'): void {
    this.patchQueryParams({ color: value, page: null });
  }

  toggleExt(value: string): void {
    const next = new Set(this.extSelected());
    if (next.has(value)) next.delete(value);
    else next.add(value);
    const csv = Array.from(next).sort().join(',');
    this.patchQueryParams({ ext: csv, page: null });
  }

  /** Quick date presets — write the from/to params directly. */
  preset(kind: 'last7' | 'last30' | 'thisYear'): void {
    const now = new Date();
    let from = '';
    if (kind === 'last7') {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      from = d.toISOString().slice(0, 10);
    } else if (kind === 'last30') {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      from = d.toISOString().slice(0, 10);
    } else {
      from = `${now.getFullYear()}-01-01`;
    }
    this.patchQueryParams({
      from,
      to: now.toISOString().slice(0, 10),
      page: null,
    });
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
    this.loading.set(true);
    this.error.set(null);
    const page = append ? this.page() + 1 : 0;
    const params: SearchParams = { ...this.currentParams(), page, limit: PAGE_SIZE };
    try {
      const r = await firstValueFrom(this.search.search(params));
      if (gen !== this.searchGen) return; // a newer request superseded us
      this.total.set(r.total);
      this.page.set(r.page);
      const vms = r.results.map((res) => this.toViewModel(res));
      this.results.update((prev) => (append ? prev.concat(vms) : vms));
      // Kick off thumb loads (fire-and-forget).
      for (const vm of vms) void this.loadThumb(vm);
    } catch (e: unknown) {
      if (gen !== this.searchGen) return;
      this.error.set(e instanceof Error ? e.message : String(e));
      if (!append) this.results.set([]);
    } finally {
      if (gen === this.searchGen) this.loading.set(false);
    }
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
    const cached = this.thumbCache.get(r.abs_path) ?? null;
    return {
      ...r,
      thumbUrl: cached,
      thumbLoading: cached === null,
    };
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
        list.map((r) =>
          r.abs_path === vm.abs_path ? { ...r, thumbLoading: false } : r,
        ),
      );
    }
  }

  // ── Result clicks → editor ───────────────────────────────────────────────
  openResult(r: ResultViewModel): void {
    void this.router.navigate(['/edit', r.id]);
  }

  // ── Template helpers ─────────────────────────────────────────────────────
  trackResult = (_: number, r: ResultViewModel) => r.id;
  trackExt = (_: number, e: { value: string }) => e.value;

  cameraLabel(c: { make: string | null; model: string | null }): string {
    return [c.make, c.model].filter(Boolean).join(' · ') || 'Unknown';
  }

  retry(): void {
    this.error.set(null);
    void this.runSearch(false);
  }
}

/** Parse a string param into a number. Empty/invalid → null. */
function numOrEmpty(v: string | null | undefined): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Read a number-input event into a string suitable for the URL (or empty
 * to strip the param). */
function numString(e: Event): string {
  const v = (e.target as HTMLInputElement).value;
  if (v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '';
}
