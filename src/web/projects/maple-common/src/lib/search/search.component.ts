// SearchComponent — top-level search experience for S7 (#622).
//
// Spec: docs/design/responsive-program/s7-search.md.
//
// Composes the search bar, scope chips, and three result sections (top
// hits, photos preview, recents). Owns:
//   - the query / scope signals (URL-synced via the host page).
//   - the 250ms debounce on query keystrokes → `SearchService.search()`.
//   - the in-flight `Subscription` so scope changes / new queries
//     cancel the previous fetch (no client-side filter — scope changes
//     re-issue a server call).
//   - the recents list persisted at `cm.search.recent`.
//
// Routing:
//   - photo tap → S5 Editor at `/edit/<id>`. If S5 hasn't merged in
//     the consuming app this still works because the Self-Hosted
//     EditorShellComponent is already at `/edit/:id` (today's contract).
//     Hosted (`maple-syrup`) routes the same id through its
//     EditorShellComponent.
//   - "See all" → currently no-op placeholder until the filtered grid
//     view lands; the spec leaves wiring to S7 (Risk §6.5) and the
//     button is wired through an output so the host can replace the
//     behaviour without touching this component.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
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

/** Map a UI scope chip to the backend `SearchParams`. v0.1 only `all` and
 * `photos` issue a real call; `places` / `people` / `albums` need a
 * server-side scope param — see spec §6 Risks. Exposed for unit tests. */
export function scopeToParams(scope: SearchScope): Partial<SearchParams> {
  switch (scope) {
    case 'all':
    case 'photos':
      return {};
    case 'places':
    case 'people':
    case 'albums':
      // Stubbed until backend scopes land.
      return {};
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
export class SearchComponent implements AfterViewInit {
  /** When true, focus the search bar on init. Hosts set this when the
   * route lands via the drawer's `searchPillTap` pill (`autoFocus=1`)
   * or when the phone Search tab becomes active. */
  readonly autoFocus = input<boolean>(false);

  /** Emitted when the user taps a photo result. Hosts route to the
   * Editor (S5) — kept as an output so this component stays router-free
   * and can be embedded inside an overlay without owning navigation. */
  readonly photoTap = output<SearchResult>();
  /** Emitted when the user taps a non-photo top hit (place / album /
   * keyword / person). v0.1 never fires this because there are no
   * non-photo top hits on the wire yet. */
  readonly topHitTap = output<TopHit>();
  /** Emitted on "See all". Hosts push to a filtered grid view. */
  readonly seeAll = output<{ query: string; scope: SearchScope }>();

  private readonly searchService = inject(SearchService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly query = signal<string>('');
  protected readonly scope = signal<SearchScope>('all');
  protected readonly results = signal<readonly SearchResult[]>([]);
  protected readonly total = signal<number>(0);
  protected readonly isStale = signal<boolean>(false);
  protected readonly recent = signal<readonly string[]>(readRecents());

  /** Top hits = head-of-`results` until a dedicated endpoint lands.
   * Derived (not a separate signal) so we never go out of sync with
   * the photo grid. */
  protected readonly topHits = computed(() =>
    topHitsFromResults(this.results() as readonly SearchResult[], 3),
  );

  /** Display state for the recents section — hidden once the user types. */
  protected readonly showRecents = computed(() => this.query().length === 0);

  /** Whether the host has issued at least one query against the API.
   * Drives the "No matches" empty state in the photos section. */
  protected readonly hasQuery = computed(() => this.query().trim().length > 0);

  @ViewChild(SearchBarComponent) private searchBar?: SearchBarComponent;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Subscription | null = null;

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
      const trimmed = q.trim();
      if (trimmed.length === 0) {
        this.results.set([]);
        this.total.set(0);
        this.isStale.set(false);
        return;
      }
      this.isStale.set(true);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        const params: SearchParams = {
          q: trimmed,
          page: 0,
          limit: 30,
          ...scopeToParams(sc),
        };
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
    });
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
  }

  protected onClear(): void {
    this.query.set('');
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

  protected onSeeAll(): void {
    this.onSubmit();
    this.seeAll.emit({ query: this.query().trim(), scope: this.scope() });
  }

  protected onRecentTap(q: string): void {
    this.query.set(q);
    // Promote the tapped recent back to the head so the list reflects
    // most-recent-first ordering even when re-tapping older items.
    const next = pushRecent(this.recent(), q);
    this.recent.set(next);
    writeRecents(next);
  }
}
