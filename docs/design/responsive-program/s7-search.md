# Responsive Program — S7: Search

Seventh sub-project of the responsive program (epic [#577](https://github.com/zubair-io/Maple/issues/577)). Fills the Search tab's content area on phone (rather than the original spec's "push from Library header"). Tablet and desktop render Search as an overlay anchored to the sidebar's search pill.

Visual reference: `/Users/riabuz/Projects/_Maple/mobile/Maple Mobile Editor.html` frame **02 · Search (active query)** plus prompt §5.3.

One ticket — **S7** — shipped as one PR.

---

## 1. Overview & deliverable map

| Ticket | What ships                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Files touched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Blocks |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **S7** | `SearchView` (Apple) / `SearchComponent` (web) populating Search tab on phone, and as an anchored overlay on tablet/desktop. Search bar with caret + `✕` clear. Scope chips (All / Photos / Places / People / Albums). Sections: Top Hits (≤3 mixed-kind), Photos · count (3-col preview grid + "See all" link to filtered grid), Recents (chip row of last 10 queries). Empty/no-results/stale states per spec. Auto-focus when entered via S1b drawer's search pill (`searchPillTap` event). | New `src/apple/Maple/Views/SearchView.swift`, new `src/apple/Maple/Views/SearchScopeChips.swift`, new `src/apple/Maple/Views/SearchTopHitRow.swift`, edits to `src/apple/Maple/Views/PhoneSearchStub.swift` (replace placeholder with `SearchView`), new `src/web/projects/maple-common/src/lib/search/search.component.{ts,html,scss,spec.ts}`, new `src/web/projects/maple/src/app/search-page.component.ts`, new `src/web/projects/maple-syrup/src/app/search-page.component.ts`, edits to web pane shell for the anchored overlay | —      |

S7 depends on S1a (Search tab routing), S1b (search-pill-tap event), existing `SearchService` (web — `src/web/projects/maple-common/src/lib/api/search.service.ts`).

---

## 2. Visual reference & behavior (mockup frame 02)

### Phone

Inside Search tab (no push, no Cancel link):

- **Search bar** (38pt). Caret: `MapleTokens.primary`, 1.5pt wide, 500ms blink. Trailing `✕` clear-circle (`MapleTokens.surfaceAlt` fill + `MapleTokens.textMuted` glyph) appears once query has ≥1 char. Auto-focuses on tab activation OR when the searchPillTap event fires from S1b drawer.
- **Scope chips**: All / Photos / Places / People / Albums. Single-select. Each scope change issues a **new** `SearchService.search()` call with the scope mapped into `SearchParams` — the API is paginated + scope-parameterized, so a client-side filter on the already-fetched page would silently drop matches that live on other pages and produce wrong counts. (Today's `SearchParams` doesn't have a single `scope` enum, so "Photos" maps to a no-op against the default search, and "Places"/"People"/"Albums" need either a per-scope endpoint or a new server-side `scope` param — see §6 Risks. For v0.1 ship "All" + "Photos" as the same call and stub the other three until the API supports them.)
- **Sections** (top → bottom, conditionally rendered):
  - **TOP HITS** (eyebrow + up to 3 hits): 36pt rounded thumb (or kind-icon if no thumb), label with the query token wrapped in `MapleTokens.primary` 600-weight, sub-label, kind tag (PLACE / ALBUM / KEYWORD / PERSON). Tap a top-hit → navigates to that resource (album → its grid, place → photos at that place, etc.).
  - **PHOTOS · {count}**: eyebrow + "See all" trailing accent link. 3-col, 9-tile preview grid (or fewer if results <9). Tap a photo → push to Loupe (S4) inside Search tab's NavStack. Tap "See all" → push to a full filtered grid view (in-tab).
  - **RECENT**: chip row of last 10 queries from `cm.search.recent` localStorage. Tap repeats the query. Hidden when current query is non-empty.

### States

- **Empty query** → only **RECENT** section visible.
- **No results** → centered muted "No matches for "{q}"" — `Lato 13pt` in `textMuted`.
- **Stale (typing in flight)** → grid dimmed to 60% opacity, no spinner. Updates atomically when results arrive.

### Tablet

- **Anchored overlay** triggered from the sidebar's search pill. Width = sidebar width (~280pt), height = remaining viewport. Backdrop dims the main pane (25%) but NOT the sidebar.
- Same content as phone (search bar / scopes / hits / photos / recent).
- Esc dismisses.

### Desktop

- **Full overlay panel** anchored to sidebar pill. 480pt wide. Scrim covers main + inspector (35%).
- Keyboard shortcuts: type to filter, Enter to commit, Esc to dismiss, `/` from anywhere opens it.

---

## 3. Apple implementation

### `SearchView.swift` (new)

```swift
struct SearchView: View {
    @Environment(\.mapleLayout) private var layout
    @State private var query: String = ""
    @State private var scope: SearchScope = .all
    // Single results stream from the API; the top-hits row picks off the
    // head until a dedicated `tophits` endpoint exists. See web §4 and §6
    // Risks for the matching wire-format note.
    @State private var photoResults: [AssetRef] = []
    private var topHits: [AssetRef] { Array(photoResults.prefix(3)) }
    @AppStorage("cm.search.recent") private var recentJSON: String = "[]"
    @FocusState private var searchFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SearchBar(query: $query, onClear: { query = ""; searchFocused = true })
                .focused($searchFocused)
            SearchScopeChips(scope: $scope)

            if query.isEmpty {
                RecentQueries(recent: recentQueries, onTap: { query = $0 })
            } else {
                TopHitsSection(hits: topHits)
                PhotoResultsSection(results: photoResults, onSeeAll: { /* push filtered grid */ })
            }
        }
        .onAppear { searchFocused = true }
        .onChange(of: query) { _, new in
            // Debounce 250ms, then fetch
            debouncedSearch(new)
        }
        .onReceive(NotificationCenter.default.publisher(for: .mapleFocusSearch)) { _ in
            searchFocused = true  // S1b drawer's searchPillTap posts this
        }
    }
}
```

### `PhoneSearchStub.swift` (replace)

```swift
struct PhoneSearchStub: View {
    var body: some View { SearchView() }
}
```

Or just delete `PhoneSearchStub` and use `SearchView` directly in `PhoneTabShell`.

### Tablet/Desktop overlay

The pane shell has a sidebar with a search pill (per spec §5b.4). Tap → presents `SearchView` as an overlay anchored to the pill. Use `.popover(isPresented:)` or a custom overlay with `MapleTokens.Motion.sheetPresent` (240ms scale-from-anchor + fade).

---

## 4. Web implementation

### `search.component.ts` (new)

```ts
@Component({
  selector: 'app-search',
  standalone: true,
  templateUrl: './search.component.html',
  styleUrl: './search.component.scss',
})
export class SearchComponent {
  private searchService = inject(SearchService); // existing
  protected readonly query = signal<string>('');
  protected readonly scope = signal<SearchScope>('all');
  // `topHits` is intentionally NOT a separate signal — the real
  // `SearchResponse` exposes a single `results` array (no top-hits split on
  // the wire). The component derives the top-hits row from the head of
  // `photoResults` until a dedicated endpoint exists. See §6 Risks.
  protected readonly photoResults = signal<AssetRef[]>([]);
  protected readonly recent = signal<string[]>(
    JSON.parse(localStorage.getItem('cm.search.recent') ?? '[]'),
  );
  @ViewChild('searchInput') searchInput!: ElementRef<HTMLInputElement>;

  private destroyRef = inject(DestroyRef);

  constructor() {
    // Debounced search effect. `SearchService.search(...)` is an `Observable`
    // (RxJS) — subscribe per query, cancel in flight on re-issue, unsub on
    // teardown. Don't await it — it isn't a Promise.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Subscription | null = null;
    effect(() => {
      const q = this.query();
      const sc = this.scope();
      if (timer) clearTimeout(timer);
      inFlight?.unsubscribe();
      if (q.length === 0) {
        this.photoResults.set([]);
        return;
      }
      timer = setTimeout(() => {
        const params: SearchParams = { q, ...this.scopeToParams(sc) };
        inFlight = this.searchService.search(params).subscribe((res) => {
          // Real shape: `SearchResponse { total, page, limit, results: SearchResult[] }`.
          // `results` is the photo list — feed it through an adapter to the
          // grid's `AssetRef` shape (id keyed `"fs:"+abs_path`, displayName
          // = filename). There is NO `topHits`/`photos` split on the wire
          // today: top-hits and photo previews come from the same `results`
          // page, with top-hits picked off the head by the component until a
          // dedicated `/api/search/tophits` (or facets-derived buckets) lands.
          this.photoResults.set(res.results.map(toAssetRef));
        });
      }, 250);
    });
    this.destroyRef.onDestroy(() => {
      if (timer) clearTimeout(timer);
      inFlight?.unsubscribe();
    });
  }

  /** Map the UI scope chip to backend `SearchParams`. v0.1 only "all" and
   * "photos" are real; the others are no-ops pending the API extension
   * called out in §6 Risks. */
  private scopeToParams(scope: SearchScope): Partial<SearchParams> {
    switch (scope) {
      case 'photos':
      case 'all':
      default:
        return {};
      case 'places':
      case 'people':
      case 'albums':
        // Stubbed until backend scopes land.
        return {};
    }
  }

  ngAfterViewInit() {
    this.searchInput.nativeElement.focus();
  }
}
```

> **Note:** the snippet drops the `topHits` signal from the previous draft of this spec — the existing `SearchResponse` does not split results into `topHits` / `photos`, so the component derives top-hits from the head of `results` (or wires a separate facets call once one exists). If you re-introduce a `topHits` signal, source it from a real endpoint, not a property that doesn't exist on `SearchResponse`.

### Search page

`src/web/projects/maple/src/app/search-page.component.ts` and same for `maple-syrup` — route component for `/search`. On init, checks `route.snapshot.queryParams['autoFocus']` — if `'1'` (set by S1b drawer's search pill tap), focuses the field. Renders `<app-search>`.

### Tablet/Desktop overlay

Web pane shell — sidebar's `<app-source-picker>` has the search pill. Tap → opens `<app-search>` inside an overlay component (`<app-anchored-overlay>` — possibly new primitive in `maple-common` if needed). Esc / outside-click dismisses.

### Recent queries

Persist `cm.search.recent` in localStorage as JSON array (max 10). Push to front on submit; dedup; truncate to 10.

---

## 5. Testing strategy

### Apple

- `XCTest`:
  - `SearchViewQueryDebounceTests` — typing rapidly fires only one fetch after 250ms.
  - `RecentQueriesTests` — submit adds to recent; dedup; cap at 10.
  - Empty/no-results/stale rendering via #Preview state-stubs.
- `#Preview` at phone + desktop layouts.

### Web

- `search.component.spec.ts`:
  - Typing fires debounced `searchService.search(...)` after 250ms (use `fakeAsync` + `tick(250)`).
  - Empty query renders only RECENT section.
  - No results renders the "No matches for {q}" message.
  - Stale state — typing while a previous fetch is in flight dims the grid (asserts CSS class).
  - autoFocus query-param focuses field on init.
- `search-scope-chips.component.spec.ts` — single-select; tap emits `scopeChange`.
- Playwright e2e — full flow: tab to Search, type "paris", see 3 top hits + photo grid + 4+ recent chips.

### CI gates

Same as S0/S1 baseline. Add a search-API integration test: `SearchService.search('paris')` returns expected shape (mocked backend in unit test; real backend in Playwright).

---

## 6. Risks & open questions

### Risks

1. **`SearchService` API shape — confirmed:** `search(params: SearchParams): Observable<SearchResponse>` where `SearchResponse = { total, page, limit, results: SearchResult[] }`. There is **no** `topHits`/`photos` split, and there is **no** single `scope` enum on `SearchParams`. S7 wires what exists: the top-hits row is derived from `results` head-of-list until a dedicated endpoint (or a facets-derived bucket) lands, and "Places / People / Albums" scopes are stubbed/no-op'd. File a follow-up ticket for: (a) a `/api/search/tophits` endpoint or a documented head-of-`results` contract; (b) a `scope` param (or per-scope endpoints) so non-photo scopes return real data.
2. **Apple `SearchService` parity** — does Apple have an equivalent search service? Existing `BrowseViewModel` / `SourcesStore` handle library data; search across all sources is a separate concern. Check `MapleCore` for a search facility; if absent, file a follow-up ticket to add it (out of S7 scope; S7 ships UI scaffold + stubs in that case).
3. **Top-hit query-token highlighting** — wrapping the matched substring in `MapleTokens.primary` 600-weight requires `AttributedString` on Apple and `<mark>` styling on web. Implement carefully — substring matching is case-insensitive, multi-word.
4. **Auto-focus on tab switch + iPad keyboard** — on iPad with hardware keyboard, auto-focusing the search field on tab activation may steal focus from elsewhere. Test on iPad sim.
5. **Recents persistence collision** — `cm.search.recent` is a new key; no collision risk, but documented in spec §2.6.

### Open questions

1. **What constitutes a "Place"?** — reverse-geocoded city from EXIF location? A user-added place chip? Both? Audit `SearchService` capabilities.
2. **"People" requires face detection** — does Maple have this? Mockup shows "People" chip; if no face data, that scope is always empty.
3. **Search debounce duration** — 250ms is typical. Tune if API roundtrip is slow.
4. **Tablet/desktop overlay anchor**: anchored to the pill exactly, OR overlay aligned to the entire sidebar column? Mockup shows pill-anchored. Confirm at PR time.
5. **"See all"** push → which view? A full filtered grid that respects the search query. Probably reuses `LibraryGrid` (S2) with a query filter. Wire as part of S7 implementation.
