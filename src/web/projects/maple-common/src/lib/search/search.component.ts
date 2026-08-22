// SearchComponent — the unified search experience (#2865, epic #2862).
//
// Design: one search model on every platform — free-text query + the
// Date / People / Places filter set — with the filter panel right-docked
// on desktop and a bottom sheet on phones, and an `@` tag picker for
// people & places. Replaces both the S7 scope-chip page and the legacy
// `/search/advanced` EXIF filter page (removed in the same change).
//
// Owns:
//   - the query / filters / sort signals. The host seeds the *initial*
//     query via `initialQuery` (the `/search?q=…` deep link); from there
//     this component owns the value.
//   - the 250ms debounce on query/filter changes → `SearchService.search()`.
//     A search fires when there is residual text OR any active filter —
//     filters-only searches are first-class (the server runs them on the
//     structured seekable path).
//   - the facets fetch (400ms debounce) that feeds the panel's People /
//     Places rows, the tag picker, and the live "Show N results" count.
//   - the `@` tag-picker state: a trailing `@token` in the query opens the
//     picker and never reaches the server (it's stripped from the fetched
//     text); picking a row toggles the filter and removes the token.
//   - infinite-scroll pagination via `onLoadMore()` (sentinel in
//     PhotoResultsSectionComponent), seek-cursor first, page fallback.
//   - result-tile thumbnails: blob URLs via FilesystemBrowseService,
//     cached for the component's lifetime (same contract the removed
//     advanced page had).
//   - the recents list persisted at `cm.search.recent` (shown when the
//     query is empty and no filter is active).
//
// Routing: photo tap → host navigates (`photoTap` output) so this
// component stays router-free.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Subscription } from 'rxjs';
import {
  AppliedDateFilter,
  SearchFacets,
  SearchParams,
  SearchResult,
  SearchService,
  seekExhausted,
} from '../api/search.service';
import { FilesystemBrowseService } from '../api/filesystem-browse.service';
import { SearchBarComponent } from './search-bar.component';
import { SearchFilterPanelComponent, FacetOption } from './search-filter-panel.component';
import { SearchTagPickerComponent, TagPick } from './search-tag-picker.component';
import { PhotoResultsSectionComponent } from './photo-results-section.component';
import { RecentQueriesComponent } from './recent-queries.component';
import { pushRecent, readRecents, writeRecents } from './search-types';
import {
  ActiveFilterChip,
  EMPTY_FILTERS,
  SearchFilters,
  activeFilterChips,
  inferredDateChip,
  activeFilterCount,
  filtersToParams,
  hasActiveFilters,
  removeChip,
  togglePerson,
  togglePlace,
} from './search-filters';

/** Inline-chip cap inside the pill — the rest collapse into "+N". */
const MAX_INLINE_CHIPS = 2;

/** Trailing `@token` matcher: an `@` at the start or after whitespace,
 * followed by non-space text, at the END of the query. Group 2 is the
 * fragment the tag picker filters on. */
const TAG_TOKEN = /(^|\s)@([^\s@]*)$/;

export type SearchSortOrder = 'captured_desc' | 'captured_asc';

@Component({
  selector: 'app-search',
  standalone: true,
  imports: [
    SearchBarComponent,
    SearchFilterPanelComponent,
    SearchTagPickerComponent,
    PhotoResultsSectionComponent,
    RecentQueriesComponent,
  ],
  templateUrl: './search.component.html',
  styleUrl: './search.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchComponent implements OnInit, AfterViewInit {
  /** When true, focus the search bar on init (phone tab activation, the
   * drawer search pill's `autoFocus=1` deep link). */
  readonly autoFocus = input<boolean>(false);

  /** Initial query the host seeds from the route (`/search?q=…`). Read once
   * in `ngOnInit` — after that this component owns the query. */
  readonly initialQuery = input<string>('');
  /** Structured filters to seed alongside `initialQuery` — the generated-
   * collection deep link (`/search?from=…&sceneType=…`). Seeded once on
   * init into the ordinary `filters` state, so every seeded value renders
   * as a removable chip rather than as invisible query narrowing. */
  readonly initialFilters = input<Partial<SearchFilters> | null>(null);

  /** Emitted when the user taps a photo result — hosts route to the
   * preview/editor surface. */
  readonly photoTap = output<SearchResult>();
  /** Emitted when the query input changes or is cleared (hosts sync `?q=`). */
  readonly queryChange = output<string>();

  private readonly searchService = inject(SearchService);
  private readonly fs = inject(FilesystemBrowseService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly query = signal<string>('');
  protected readonly filters = signal<SearchFilters>(EMPTY_FILTERS);
  protected readonly sort = signal<SearchSortOrder>('captured_desc');
  protected readonly results = signal<readonly SearchResult[]>([]);
  protected readonly total = signal<number>(0);
  protected readonly isStale = signal<boolean>(false);
  protected readonly recent = signal<readonly string[]>(readRecents());
  protected readonly page = signal<number>(0);
  /** Seek cursor for the next page (#2129); `null` on the relevance-ranked
   * text path or when the chain is exhausted — `onLoadMore` falls back to
   * `page + 1`, so both pagination modes coexist. */
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly isLoadingMore = signal<boolean>(false);
  /** Phone/tablet filter sheet visibility. On desktop (≥1024px) the panel
   * is a permanently-docked column and this flag has no visible effect. */
  protected readonly panelOpen = signal<boolean>(false);
  /** Facets for the panel rows + tag picker + live "Show N" count. */
  protected readonly facets = signal<SearchFacets | null>(null);
  /** Date window the server applied, so an inferred one is never invisible. */
  protected readonly appliedDates = signal<AppliedDateFilter | undefined>(undefined);
  /** Result-id → blob URL, patched as thumbnails resolve. */
  protected readonly thumbUrls = signal<ReadonlyMap<string, string>>(new Map());
  /** Fragment of a trailing `@token` the user dismissed — keeps the picker
   * closed for that exact token until typing changes it. */
  private readonly dismissedTag = signal<string | null>(null);

  /** The trailing `@token` fragment, or null when the query has none. */
  protected readonly tagFragment = computed(() => {
    const m = TAG_TOKEN.exec(this.query());
    return m === null ? null : m[2];
  });

  protected readonly tagPickerOpen = computed(
    () => this.tagFragment() !== null && this.tagFragment() !== this.dismissedTag(),
  );

  /** The text the server sees: the query minus any trailing `@token`
   * (which belongs to the picker, not the search). */
  protected readonly effectiveText = computed(() => this.query().replace(TAG_TOKEN, '$1').trim());

  protected readonly hasText = computed(() => this.effectiveText().length > 0);
  protected readonly filtersActive = computed(() => hasActiveFilters(this.filters()));
  protected readonly activeCount = computed(() => activeFilterCount(this.filters()));

  protected readonly allChips = computed(() => {
    const inferred = inferredDateChip(this.appliedDates());
    // Appended, not prepended: the user's own filters stay in their
    // established order and the derived one reads as an addition to them.
    return inferred === null
      ? activeFilterChips(this.filters())
      : [...activeFilterChips(this.filters()), inferred];
  });
  protected readonly visibleChips = computed(() => this.allChips().slice(0, MAX_INLINE_CHIPS));
  protected readonly overflowCount = computed(
    () => this.allChips().length - this.visibleChips().length,
  );

  protected readonly facetPeople = computed<readonly FacetOption[]>(
    () => this.facets()?.people ?? [],
  );
  protected readonly facetPlaces = computed<readonly FacetOption[]>(
    () => this.facets()?.places ?? [],
  );
  protected readonly facetTotal = computed(() => this.facets()?.total ?? null);

  /** True when there are server-side results not yet loaded locally. */
  protected readonly canLoadMore = computed(() => this.results().length < this.total());

  /** Empty state — recents render only when nothing is being searched. */
  protected readonly showRecents = computed(() => !this.hasText() && !this.filtersActive());

  protected readonly totalLabel = computed(
    () => `${this.total().toLocaleString()} ${this.total() === 1 ? 'result' : 'results'}`,
  );

  @ViewChild(SearchBarComponent) private searchBar?: SearchBarComponent;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private facetsTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Subscription | null = null;
  private facetsInFlight: Subscription | null = null;
  private loadMoreSub: Subscription | null = null;
  /** Lifetime blob-URL cache (id → URL) behind the `thumbUrls` signal, so
   * back-and-forth queries restore instantly. */
  private readonly thumbCache = new Map<string, string>();
  private thumbQueue: SearchResult[] = [];
  private thumbActive = 0;

  constructor() {
    // Reactive search effect — keystrokes and filter edits coalesce into
    // one fetch 250ms after the last change. Re-issuing the search cancels
    // the previous subscription so a slow first response can't overwrite a
    // fast second one. Reads `effectiveText` (memoized), so typing inside
    // a trailing `@token` does NOT re-fetch — the token never reaches the
    // server.
    effect(() => {
      const text = this.effectiveText();
      const f = this.filters();
      const sort = this.sort();
      if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
      this.inFlight?.unsubscribe();
      this.inFlight = null;
      this.loadMoreSub?.unsubscribe();
      this.loadMoreSub = null;
      this.isLoadingMore.set(false);
      if (text.length === 0 && !hasActiveFilters(f)) {
        this.results.set([]);
        this.total.set(0);
        this.page.set(0);
        this.nextCursor.set(null);
        this.appliedDates.set(undefined);
        this.isStale.set(false);
        return;
      }
      this.isStale.set(true);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.page.set(0);
        this.nextCursor.set(null);
        this.inFlight = this.searchService.search(this.buildParams({ page: 0 })).subscribe({
          next: (res) => {
            this.results.set(res.results);
            this.nextCursor.set(res.nextCursor ?? null);
            this.appliedDates.set(res.dateFilter);
            this.total.set(seekExhausted(res) ? res.results.length : res.total);
            this.isStale.set(false);
            this.queueThumbs(res.results);
          },
          error: () => {
            // Non-fatal — stop dimming but leave existing results so a
            // transient backend hiccup doesn't clobber the user's view.
            this.isStale.set(false);
          },
        });
      }, 250);
    });

    // Facets effect — refreshes the panel rows, the tag-picker lists, and
    // the live "Show N results" count. Also runs with nothing active so
    // the pickers have library-wide content before the first filter. The
    // longer debounce keeps aggregation load off the keystroke path.
    effect(() => {
      const text = this.effectiveText();
      const f = this.filters();
      // Read both so either triggers a refresh; values are rebuilt below.
      void text;
      void f;
      if (this.facetsTimer !== null) clearTimeout(this.facetsTimer);
      this.facetsInFlight?.unsubscribe();
      this.facetsTimer = setTimeout(() => {
        this.facetsTimer = null;
        const {
          page: _page,
          limit: _limit,
          cursor: _cursor,
          sort: _sort,
          ...facetParams
        } = this.buildParams({ page: 0 });
        this.facetsInFlight = this.searchService.facets(facetParams).subscribe({
          next: (f2) => this.facets.set(f2),
          error: () => {
            // Keep the last good facets — an aggregation hiccup shouldn't
            // blank the pickers.
          },
        });
      }, 400);
    });

    this.destroyRef.onDestroy(() => {
      if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
      if (this.facetsTimer !== null) clearTimeout(this.facetsTimer);
      this.inFlight?.unsubscribe();
      this.facetsInFlight?.unsubscribe();
      this.loadMoreSub?.unsubscribe();
    });
  }

  ngOnInit(): void {
    const seed = this.initialQuery().trim();
    if (seed) this.query.set(seed);
    const seededFilters = this.initialFilters();
    if (seededFilters !== null) {
      this.filters.set({ ...EMPTY_FILTERS, ...seededFilters });
    }
  }

  ngAfterViewInit(): void {
    if (this.autoFocus()) {
      // Defer one microtask so the DOM has settled — important on iOS
      // where focusing during initial layout opens the keyboard before
      // the field is laid out.
      queueMicrotask(() => this.searchBar?.focus());
    }
  }

  /** Imperative focus hook — hosts call this when the search-pill tap
   * arrives after the route is already mounted. */
  focusSearchBar(): void {
    this.searchBar?.focus();
  }

  private buildParams(paging: { page?: number; cursor?: string }): SearchParams {
    const text = this.effectiveText();
    return {
      // The box is the *content* search: the term routes to `placeQuery`
      // (unified search_blob + NL dates + semantic ranking), never `q`
      // (filename substring) — see #502/#518.
      ...(text.length > 0 ? { placeQuery: text } : {}),
      ...filtersToParams(this.filters()),
      // With residual text the server ranks by relevance and ignores
      // `sort`; the meta row shows "Best match" then instead of the
      // Newest/Oldest control, so the UI never promises an order the
      // server won't deliver.
      ...(text.length === 0 ? { sort: this.sort() } : {}),
      ...(paging.cursor !== undefined ? { cursor: paging.cursor } : { page: paging.page ?? 0 }),
      limit: 30,
    };
  }

  // ── Thumbnails ───────────────────────────────────────────────────────────

  /** Queue blob-URL loads for results not yet cached, 4-wide. */
  private queueThumbs(results: readonly SearchResult[]): void {
    const fresh = results.filter(
      (r) => !this.thumbCache.has(r.id) && !this.thumbQueue.some((q) => q.id === r.id),
    );
    this.thumbQueue.push(...fresh);
    this.publishThumbs();
    this.drainThumbQueue();
  }

  private drainThumbQueue(): void {
    while (this.thumbActive < 4 && this.thumbQueue.length > 0) {
      const next = this.thumbQueue.shift()!;
      this.thumbActive += 1;
      void this.fs
        .getThumbBlobUrl(next.abs_path)
        .then((url) => {
          this.thumbCache.set(next.id, url);
          this.publishThumbs();
        })
        .catch(() => {
          // Tile keeps its placeholder glyph.
        })
        .finally(() => {
          this.thumbActive -= 1;
          this.drainThumbQueue();
        });
    }
  }

  private publishThumbs(): void {
    this.thumbUrls.set(new Map(this.thumbCache));
  }

  // ── Bar handlers ─────────────────────────────────────────────────────────

  protected onQueryChange(q: string): void {
    this.query.set(q);
    // A dismissed token stays dismissed only while unchanged — typing
    // reopens the picker for the new fragment.
    if (this.tagFragment() !== this.dismissedTag()) this.dismissedTag.set(null);
    this.queryChange.emit(q);
  }

  protected onClear(): void {
    this.query.set('');
    this.dismissedTag.set(null);
    this.queryChange.emit('');
  }

  protected onSubmit(): void {
    const q = this.effectiveText();
    if (q.length === 0) return;
    const next = pushRecent(this.recent(), q);
    this.recent.set(next);
    writeRecents(next);
  }

  protected onChipRemove(chip: ActiveFilterChip): void {
    this.filters.set(removeChip(this.filters(), chip));
  }

  protected onFiltersTap(): void {
    this.panelOpen.set(true);
  }

  // ── Filter panel handlers ────────────────────────────────────────────────

  protected onFiltersChange(f: SearchFilters): void {
    this.filters.set(f);
  }

  protected onClearAll(): void {
    this.filters.set(EMPTY_FILTERS);
  }

  protected onPanelDismiss(): void {
    this.panelOpen.set(false);
  }

  // ── Tag picker handlers ──────────────────────────────────────────────────

  protected onTagPick(pick: TagPick): void {
    const f = this.filters();
    this.filters.set(
      pick.kind === 'person' ? togglePerson(f, pick.value) : togglePlace(f, pick.value),
    );
    // Strip the `@token` the pick consumed; what remains is plain query text.
    const stripped = this.query().replace(TAG_TOKEN, '$1').replace(/\s+$/, '');
    this.query.set(stripped);
    this.dismissedTag.set(null);
    this.queryChange.emit(stripped);
    this.searchBar?.focus();
  }

  protected onTagDismiss(): void {
    this.dismissedTag.set(this.tagFragment());
  }

  // ── Result handlers ──────────────────────────────────────────────────────

  protected onPhotoTap(r: SearchResult): void {
    // Commit to recents on a navigation event so the user always gets a
    // history entry, even if they didn't press Enter.
    this.onSubmit();
    this.photoTap.emit(r);
  }

  protected onSortChange(e: Event): void {
    const v = (e.target as HTMLSelectElement).value;
    this.sort.set(v === 'captured_asc' ? 'captured_asc' : 'captured_desc');
  }

  protected onLoadMore(): void {
    // Skip while a fresh (page-0) search is debouncing/in flight: the
    // sentinel can still be intersecting from the previous result set.
    if (this.isStale() || !this.canLoadMore() || this.isLoadingMore()) return;
    if (!this.hasText() && !this.filtersActive()) return;
    this.isLoadingMore.set(true);
    const cursor = this.nextCursor();
    const nextPage = this.page() + 1;
    const params =
      cursor !== null ? this.buildParams({ cursor }) : this.buildParams({ page: nextPage });
    this.loadMoreSub?.unsubscribe();
    this.loadMoreSub = this.searchService.search(params).subscribe({
      next: (res) => {
        const merged = [...this.results(), ...res.results];
        this.results.set(merged);
        this.nextCursor.set(res.nextCursor ?? null);
        this.total.set(seekExhausted(res) ? merged.length : res.total);
        // `page` is the skip-mode fallback counter — a seek request leaves
        // it alone rather than adopting the server's echoed `page: 0`.
        if (cursor === null) this.page.set(nextPage);
        this.isLoadingMore.set(false);
        this.queueThumbs(res.results);
      },
      error: () => {
        this.isLoadingMore.set(false);
      },
    });
  }

  protected onRecentTap(q: string): void {
    this.query.set(q);
    this.queryChange.emit(q);
    // Promote the tapped recent back to the head so the list reflects
    // most-recent-first ordering even when re-tapping older items.
    const next = pushRecent(this.recent(), q);
    this.recent.set(next);
    writeRecents(next);
  }
}
