// SearchComponent — top-level search experience for S7 (#622).
//
// Spec: docs/design/responsive-program/s7-search.md.
//
// Composes the search bar, scope chips, and three result sections (top
// hits, photos preview, recents). Owns:
//   - the query / scope signals. The host seeds the *initial* query via the
//     `initialQuery` input (e.g. the `/search?q=…` deep link the toolbar and
//     drawer search pill push to); from there this component owns the value.
//     Live keystroke → URL round-trip is not implemented and not needed.
//   - the 250ms debounce on query keystrokes → `SearchService.search()`.
//   - the in-flight `Subscription` so scope changes / new queries
//     cancel the previous fetch (no client-side filter — scope changes
//     re-issue a server call).
//   - infinite-scroll pagination via `onLoadMore()` (driven by the sentinel
//     in PhotoResultsSectionComponent).
//   - the recents list persisted at `cm.search.recent`.
//
// Routing:
//   - photo tap → S5 Editor at `/edit/<id>`. If S5 hasn't merged in
//     the consuming app this still works because the Self-Hosted
//     EditorShellComponent is already at `/edit/:id` (today's contract).
//     Hosted (`maple-syrup`) routes the same id through its
//     EditorShellComponent.
//   - Filters → host navigates to the advanced filter page with the current
//     query + scope prefilled. Wired through the `filters` output so this
//     component stays router-free.

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
import { SearchParams, SearchResult, SearchService } from '../api/search.service';
import { SearchBarComponent } from './search-bar.component';
import { SearchScopeChipsComponent } from './search-scope-chips.component';
import { TopHitsSectionComponent } from './top-hits-section.component';
import { PhotoResultsSectionComponent } from './photo-results-section.component';
import { RecentQueriesComponent } from './recent-queries.component';
import {
  SearchScope,
  TopHit,
  pushRecent,
  readRecents,
  topHitsFromResults,
  writeRecents,
} from './search-types';

/** Map a UI scope chip to the backend `SearchParams`. `all` keeps the
 * default no-scope request (the backend returns the full live set);
 * every other chip populates the `scope` param so the server filters by
 * the underlying field. `albums` is recognised end-to-end but the
 * backend currently returns `notImplemented: true` because no album
 * field exists yet — the FE keeps the chip enabled so the UI affordance
 * is uniform. See `#644` and `routes/search/query.ts`. */
export function scopeToParams(scope: SearchScope): Partial<SearchParams> {
  switch (scope) {
    case 'all':
      return {};
    case 'photos':
    case 'places':
    case 'people':
    case 'albums':
      return { scope };
  }
}

@Component({
  selector: 'app-search',
  standalone: true,
  imports: [
    SearchBarComponent,
    SearchScopeChipsComponent,
    TopHitsSectionComponent,
    PhotoResultsSectionComponent,
    RecentQueriesComponent,
  ],
  templateUrl: './search.component.html',
  styleUrl: './search.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchComponent implements OnInit, AfterViewInit {
  /** When true, focus the search bar on init. Hosts set this when the
   * route lands via the drawer's `searchPillTap` pill (`autoFocus=1`)
   * or when the phone Search tab becomes active. */
  readonly autoFocus = input<boolean>(false);

  /** Initial query the host seeds from the route (`/search?q=…`). Read once
   * in `ngOnInit` — after that this component owns the query. Empty/whitespace
   * leaves the bar blank (the effect trims before fetching, so no request
   * fires for a whitespace-only seed). */
  readonly initialQuery = input<string>('');

  /** When true, render the "Filters" button (emits `filters`). Hosts that
   * have an advanced filter page (`/search/advanced`) set this; hosts without
   * one (e.g. Hosted/maple-syrup) leave it false so no dead control shows. */
  readonly showFilters = input<boolean>(false);

  /** Emitted when the user taps a photo result. Hosts route to the
   * Editor (S5) — kept as an output so this component stays router-free
   * and can be embedded inside an overlay without owning navigation. */
  readonly photoTap = output<SearchResult>();
  /** Emitted when the user taps a non-photo top hit (place / album /
   * keyword / person). v0.1 never fires this because there are no
   * non-photo top hits on the wire yet. */
  readonly topHitTap = output<TopHit>();
  /** Emitted when the user taps the Filters button. Hosts navigate to the
   * advanced filter page (`/search/advanced`) with the current query + scope
   * prefilled as query params. */
  readonly filters = output<{ query: string; scope: SearchScope }>();
  /** Emitted when the query input changes or is cleared. */
  readonly queryChange = output<string>();

  private readonly searchService = inject(SearchService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly query = signal<string>('');
  protected readonly scope = signal<SearchScope>('all');
  protected readonly results = signal<readonly SearchResult[]>([]);
  protected readonly total = signal<number>(0);
  protected readonly isStale = signal<boolean>(false);
  protected readonly recent = signal<readonly string[]>(readRecents());
  protected readonly page = signal<number>(0);
  protected readonly isLoadingMore = signal<boolean>(false);

  /** Top hits = head-of-`results` until a dedicated endpoint lands.
   * Derived (not a separate signal) so we never go out of sync with
   * the photo grid. */
  protected readonly topHits = computed(() =>
    topHitsFromResults(this.results() as readonly SearchResult[], 3),
  );

  /** True when there are server-side results not yet loaded locally. */
  protected readonly canLoadMore = computed(() => this.results().length < this.total());

  /** Display state for the recents section — hidden once the user types.
   * Uses `trim()` so whitespace-only input behaves like an empty query
   * (matching the search effect + `hasQuery`); otherwise typing spaces
   * would hide recents while neither results nor the empty-state render. */
  protected readonly showRecents = computed(() => this.query().trim().length === 0);

  /** Whether the host has issued at least one query against the API.
   * Drives the "No matches" empty state in the photos section. */
  protected readonly hasQuery = computed(() => this.query().trim().length > 0);

  @ViewChild(SearchBarComponent) private searchBar?: SearchBarComponent;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Subscription | null = null;
  private loadMoreSub: Subscription | null = null;

  constructor() {
    // Reactive search effect — keystrokes mutate `query()` / `scope()`,
    // and this effect coalesces them into one fetch 250ms after the last
    // change. Re-issuing the search cancels the previous subscription so
    // a slow first response can't overwrite a fast second one.
    effect(() => {
      const q = this.query();
      const sc = this.scope();
      if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
      this.inFlight?.unsubscribe();
      this.inFlight = null;
      // Also cancel any in-flight load-more — the query changed, so the
      // page we were loading is stale.
      this.loadMoreSub?.unsubscribe();
      this.loadMoreSub = null;
      this.isLoadingMore.set(false);
      const trimmed = q.trim();
      if (trimmed.length === 0) {
        this.results.set([]);
        this.total.set(0);
        this.page.set(0);
        this.isStale.set(false);
        return;
      }
      this.isStale.set(true);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        const params: SearchParams = {
          // The responsive box is the *content* search: route the term to
          // `placeQuery` (unified search_blob — place + caption + OCR + people,
          // plus NL-date parsing and semantic ranking when Meilisearch is
          // configured), matching the advanced search box. Sending `q`
          // (filename/path substring) here meant a search for a place, person,
          // or caption returned nothing — only literal filename hits.
          placeQuery: trimmed,
          page: 0,
          limit: 30,
          ...scopeToParams(sc),
        };
        this.page.set(0);
        this.inFlight = this.searchService.search(params).subscribe({
          next: (res) => {
            this.results.set(res.results);
            this.total.set(res.total);
            this.isStale.set(false);
          },
          error: () => {
            // Non-fatal — clear stale state so the UI stops dimming, but
            // leave existing results in place so a transient backend hiccup
            // doesn't clobber the user's view.
            this.isStale.set(false);
          },
        });
      }, 250);
    });

    this.destroyRef.onDestroy(() => {
      if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
      this.inFlight?.unsubscribe();
      this.loadMoreSub?.unsubscribe();
    });
  }

  ngOnInit(): void {
    // Seed the query from the host (`/search?q=…`) before first render so the
    // bar shows the deep-linked term and the constructor's search effect fires
    // the initial fetch. Runs once — keystrokes own the value afterwards. Trim
    // first so a whitespace-only seed leaves the bar blank (matches the
    // `initialQuery` docstring) rather than rendering stray spaces.
    const seed = this.initialQuery().trim();
    if (seed) this.query.set(seed);
  }

  ngAfterViewInit(): void {
    if (this.autoFocus()) {
      // Defer one microtask so the DOM has settled — important on iOS
      // where focusing in the same task as initial layout fires keyboard
      // open before the field is laid out.
      queueMicrotask(() => this.searchBar?.focus());
    }
  }

  /** Imperative focus hook — hosts call this when the search-pill
   * `searchPillTap` event arrives after the route is already mounted. */
  focusSearchBar(): void {
    this.searchBar?.focus();
  }

  // ── Bar handlers ─────────────────────────────────────────────────────────

  protected onQueryChange(q: string): void {
    this.query.set(q);
    this.queryChange.emit(q);
  }

  protected onClear(): void {
    this.query.set('');
    this.queryChange.emit('');
  }

  protected onSubmit(): void {
    const q = this.query().trim();
    if (q.length === 0) return;
    const next = pushRecent(this.recent(), q);
    this.recent.set(next);
    writeRecents(next);
  }

  protected onScopeChange(scope: SearchScope): void {
    this.scope.set(scope);
  }

  // ── Result handlers ──────────────────────────────────────────────────────

  protected onPhotoTap(r: SearchResult): void {
    // Commit to recents on a navigation event so the user always gets a
    // history entry, even if they didn't press Enter.
    this.onSubmit();
    this.photoTap.emit(r);
  }

  protected onTopHitTap(hit: TopHit): void {
    if (hit.kind === 'photo' && hit.source) {
      this.onPhotoTap(hit.source);
      return;
    }
    this.topHitTap.emit(hit);
  }

  protected onLoadMore(): void {
    const q = this.query().trim();
    // Skip while a fresh (page-0) search is debouncing/in flight: the sentinel
    // can still be intersecting from the previous result set, and paging the
    // NEW query before page 0 returns would desync `page` and mix results.
    if (this.isStale() || !this.canLoadMore() || this.isLoadingMore() || q.length === 0) return;
    this.isLoadingMore.set(true);
    const nextPage = this.page() + 1;
    const params: SearchParams = {
      placeQuery: q,
      page: nextPage,
      limit: 30,
      ...scopeToParams(this.scope()),
    };
    this.loadMoreSub?.unsubscribe();
    this.loadMoreSub = this.searchService.search(params).subscribe({
      next: (res) => {
        this.results.update((prev) => [...prev, ...res.results]);
        this.total.set(res.total);
        this.page.set(nextPage);
        this.isLoadingMore.set(false);
      },
      error: () => {
        this.isLoadingMore.set(false);
      },
    });
  }

  protected onFilters(): void {
    // Commit the query to recents on navigation, matching onPhotoTap() (and
    // the prior onSeeAll() behaviour) so opening Filters records the search.
    this.onSubmit();
    this.filters.emit({ query: this.query().trim(), scope: this.scope() });
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
