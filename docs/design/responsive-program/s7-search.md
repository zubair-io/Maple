# Responsive Program — S7: Search

Seventh sub-project of the responsive program (epic [#577](https://github.com/zubair-io/Maple/issues/577)). Fills the Search tab's content area on phone (rather than the original spec's "push from Library header"). Tablet and desktop render Search as an overlay anchored to the sidebar's search pill.

Visual reference: `/Users/riabuz/Projects/_Maple/mobile/Maple Mobile Editor.html` frame **02 · Search (active query)** plus prompt §5.3.

One ticket — **S7** — shipped as one PR.

---

## 1. Overview & deliverable map

| Ticket | What ships | Files touched | Blocks |
|---|---|---|---|
| **S7** | `SearchView` (Apple) / `SearchComponent` (web) populating Search tab on phone, and as an anchored overlay on tablet/desktop. Search bar with caret + `✕` clear. Scope chips (All / Photos / Places / People / Albums). Sections: Top Hits (≤3 mixed-kind), Photos · count (3-col preview grid + "See all" link to filtered grid), Recents (chip row of last 10 queries). Empty/no-results/stale states per spec. Auto-focus when entered via S1b drawer's search pill (`searchPillTap` event). | New `src/apple/Maple/Views/SearchView.swift`, new `src/apple/Maple/Views/SearchScopeChips.swift`, new `src/apple/Maple/Views/SearchTopHitRow.swift`, edits to `src/apple/Maple/Views/PhoneSearchStub.swift` (replace placeholder with `SearchView`), new `src/web/projects/maple-common/src/lib/search/search.component.{ts,html,scss,spec.ts}`, new `src/web/projects/maple/src/app/search-page.component.ts`, new `src/web/projects/maple-syrup/src/app/search-page.component.ts`, edits to web pane shell for the anchored overlay | — |

S7 depends on S1a (Search tab routing), S1b (search-pill-tap event), existing `SearchService` (web — `src/web/projects/maple-common/src/lib/api/search.service.ts`).

---

## 2. Visual reference & behavior (mockup frame 02)

### Phone

Inside Search tab (no push, no Cancel link):

- **Search bar** (38pt). Caret: `MapleTokens.primary`, 1.5pt wide, 500ms blink. Trailing `✕` clear-circle (`MapleTokens.surfaceAlt` fill + `MapleTokens.textMuted` glyph) appears once query has ≥1 char. Auto-focuses on tab activation OR when the searchPillTap event fires from S1b drawer.
- **Scope chips**: All / Photos / Places / People / Albums. Single-select. Refilters in place — no refetch on scope change (filter the already-fetched result set client-side).
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
    @State private var topHits: [SearchHit] = []
    @State private var photoResults: [AssetRef] = []
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
  private searchService = inject(SearchService);  // existing
  protected readonly query = signal<string>('');
  protected readonly scope = signal<SearchScope>('all');
  protected readonly topHits = signal<SearchHit[]>([]);
  protected readonly photoResults = signal<AssetRef[]>([]);
  protected readonly recent = signal<string[]>(
    JSON.parse(localStorage.getItem('cm.search.recent') ?? '[]'),
  );
  @ViewChild('searchInput') searchInput!: ElementRef<HTMLInputElement>;

  constructor() {
    // Debounced search effect
    let timer: ReturnType<typeof setTimeout> | null = null;
    effect(() => {
      const q = this.query();
      if (timer) clearTimeout(timer);
      if (q.length === 0) {
        this.topHits.set([]);
        this.photoResults.set([]);
        return;
      }
      timer = setTimeout(() => this.fetch(q), 250);
    });
  }

  private async fetch(q: string) {
    const results = await this.searchService.search(q, this.scope());
    this.topHits.set(results.topHits);
    this.photoResults.set(results.photos);
  }

  ngAfterViewInit() {
    this.searchInput.nativeElement.focus();
  }
}
```

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

1. **`SearchService` API shape** — existing `search.service.ts` in `maple-common`. Audit its return type: does it already split into top-hits / photos / etc.? If not, either extend the service (small change) or post-process in the component.
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
