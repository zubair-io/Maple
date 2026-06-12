# Responsive Program — S2: Library Grid

Third sub-project of the responsive program (epic [#577](https://github.com/zubair-io/Maple/issues/577)). Fills the Library tab's content area with a responsive photo grid across all three breakpoints. Depends on S1a (PhoneTabShell), S1b (source-picker drawer), and S0a (`MapleLayout` env / `LayoutService` signal).

Visual reference: `/Users/riabuz/Projects/_Maple/mobile/maple-mobile-editor.html` frame **00 · Library grid** (phone), plus the existing pane-shell desktop grid.

This doc is the contract for one ticket — **S2** — shipped as one PR.

---

## 1. Overview & deliverable map

| Ticket | What ships                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Files touched                                                                                                                                                                                                                                                                                                                                                                                                                      | Blocks                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **S2** | Responsive `LibraryGrid` view replacing the existing PhoneLibraryStub placeholder. Phone (<768pt): 3-col edge-bleed (2pt gaps, 2pt horizontal padding, 0 vertical), title (Merriweather 28pt/700), filter chips (`All / Picks / 4+ stars / Edited`), cell badges (pick dot top-left, ≥4★ stars bottom-left). Tablet (768–1024pt): 5-col with 4pt gaps + 8pt outer padding. Desktop (>1024pt): `auto-fill minmax(180pt, 1fr)` with 4pt gaps + 12pt padding. Cell selection haptic (`.selection` on iOS, `navigator.vibrate(4)` on web). Cell→Loupe push triggers tab-bar hide on phone. | `src/apple/Maple/Views/PhoneLibraryStub.swift` (rename → `PhoneLibraryView.swift`), new `src/apple/Maple/Views/LibraryGrid.swift`, `src/apple/Maple/Views/BrowseGrid.swift` (extract shared cell), new `src/web/projects/maple-common/src/lib/library/library-grid.component.{ts,html,scss,spec.ts}`, `src/web/projects/maple/src/app/library-page.component.ts`, `src/web/projects/maple-syrup/src/app/library-page.component.ts` | S4 (Loupe push integration) |

S2 depends on:

- S0a — `MapleLayout` env signal
- S1a — `PhoneLibraryStub` placeholder it replaces
- S1b — `cm.source` persistence for "currently-viewed source"

S2 unblocks S4 (Loupe pushes from grid cell tap).

---

## 2. Visual reference & behavior

### Phone (mockup frame 00)

- **Header** scrolls with content (not sticky). L→R: `☰` hamburger (opens S1b drawer) · `MAPLE` wordmark (centered, accent color, Lato Bold 11pt) · `⋯` overflow (right).
- **Title**: Merriweather 28pt/700, current source name (`MapleTokens.Typography.sourceTitle` from S0b), tracking `-0.5pt`. Example: "France trip".
- **Filter chips**: row of 4 single-select chips below title. `All` (default selected) · `Picks` · `4+ stars` · `Edited`. Active chip = `MapleTokens.primary` 22% fill + `MapleTokens.primary` border + `MapleTokens.primary` text. Idle chip = `MapleTokens.surfaceAlt` fill + `MapleTokens.border` border + `MapleTokens.textMuted` text. Hit area ≥ 28pt tall (chip visual 22pt, padded transparently).
- **Grid**: 3 columns, `aspect-ratio: 1/1`, center-cover crop, **2pt gaps**, **2pt horizontal padding**, **no vertical padding** (edge-bleed).
- **Cell badges**: pick = 6pt green dot (`MapleTokens.successText`) top-left 4pt inset; stars (≥4) = 6pt gold star glyphs (`MapleTokens.star`) bottom-left 4pt inset. No reject badge in v0.1.
- **Interactions**: cell tap → push to Loupe (selection haptic, navigation hides tab bar). Filter chip tap → cross-fade content 120ms (`MapleTokens.Motion.filterFade`). Hamburger tap → S1b drawer.

### Tablet (768–1024pt)

- **Same header chrome** (hamburger / wordmark / overflow), but hamburger opens an **inline sidebar drawer** in place of the source picker (already always-visible on desktop pane shell — tablet collapses it to drawer by default, expandable).
- **Grid**: 5 columns, **4pt gaps**, **8pt outer padding** (no longer edge-bleed at this size — austere otherwise).

### Desktop (>1024pt)

- **No hamburger** — sidebar is always visible (pane shell).
- **Grid**: `grid-template-columns: repeat(auto-fill, minmax(180pt, 1fr))`, **4pt gaps**, **12pt outer padding**.
- Hover affordances enabled (per spec §5b.3): cell hover = 1.5pt accent outline inset.

---

## 3. Apple implementation

### Files

- **Rename** `src/apple/Maple/Views/PhoneLibraryStub.swift` → `PhoneLibraryView.swift`. Replaces the "Grid placeholder" Text with `LibraryGrid()`.
- **New** `src/apple/Maple/Views/LibraryGrid.swift`:

  ```swift
  struct LibraryGrid: View {
      @Environment(\.mapleLayout) private var layout
      @Bindable var browseVM: BrowseViewModel
      @AppStorage("cm.filter") private var filter: String = "all"

      var body: some View {
          let gap: CGFloat = layout == .phone ? 2 : 4
          let outerPad: CGFloat = layout == .phone ? 2 : (layout == .tablet ? 8 : 12)

          // Phone: 3 fixed columns. Tablet: 5 fixed columns. Desktop: adaptive
          // tracks at minmax(180pt, 1fr) — matches the web `minmax(180px, 1fr)`
          // rule above, so wide windows pack more cells instead of capping at
          // an arbitrary count. Existing `BrowseGrid` already uses an adaptive
          // GridItem; this mirrors that pattern at a 180pt minimum.
          let columns: [GridItem] = {
              switch layout {
              case .phone:
                  return Array(repeating: GridItem(.flexible(), spacing: gap), count: 3)
              case .tablet:
                  return Array(repeating: GridItem(.flexible(), spacing: gap), count: 5)
              default:
                  return [GridItem(.adaptive(minimum: 180), spacing: gap)]
              }
          }()

          ScrollView {
              VStack(alignment: .leading, spacing: 0) {
                  LibraryHeader(title: browseVM.sourceTitle)
                  FilterChipRow(active: $filter)
                  LazyVGrid(columns: columns, spacing: gap) {
                      ForEach(filteredAssets) { asset in
                          LibraryCell(asset: asset)
                              .onTapGesture { /* push to Loupe — S4 destination */ }
                      }
                  }
                  .padding(.horizontal, outerPad)
              }
          }
      }
  }
  ```

- **New** `src/apple/Maple/Views/LibraryCell.swift` — extracted from existing `BrowseGrid.swift` cell code; renders thumbnail + pick dot + star row badges. `aspect-ratio: 1/1`, center-cover crop.
- **Edit** `src/apple/Maple/Views/BrowseGrid.swift` — Apple desktop's existing grid; refactored to use the new `LibraryCell` (shared with phone). Existing cell logic moves to `LibraryCell`.

### Persistence

- `cm.filter` (existing): which chip is active. The current `BrowsePreferencesService.CullFilter` enum (web) accepts `"all" | "picks" | "4stars"`; S2 reuses those values verbatim so existing persisted preferences continue to work. The fourth chip (`"edited"`) is **new** — landing it requires extending `CullFilter` (and the Apple `@AppStorage` mirror) to `"all" | "picks" | "4stars" | "edited"` in the same PR. Older clients reading the new value fall through to `"all"` via the existing default.
- `cm.source` (S0a): which source is currently shown (drives grid content).

### Filter implementation

`filteredAssets` computed from `browseVM.assets` filtered by `cm.filter` (string matches the persisted `CullFilter` value above):

- `"all"` → no filter
- `"picks"` → `assets.filter { $0.cullingState.flag == .pick }`
- `"4stars"` → `assets.filter { $0.cullingState.stars >= 4 }`
- `"edited"` → `assets.filter { $0.hasEdits }` — requires a `hasEdits` computed property on `AssetRef` (audit; if missing, file a follow-up to populate). Also requires the `CullFilter` schema extension noted above.

---

## 4. Web implementation

### Files

- **New** `src/web/projects/maple-common/src/lib/library/library-grid.component.{ts,html,scss}` — standalone, signals, separate templates per CLAUDE.md.
  ```ts
  @Component({ selector: 'app-library-grid', standalone: true /* ... */ })
  export class LibraryGridComponent {
    private layoutService = inject(LayoutService);
    private libraryState = inject(LibraryStateService); // existing
    protected readonly layout = this.layoutService.layout;
    protected readonly assets = this.libraryState.filteredAssets; // computed signal
    protected readonly activeFilter = signal<string>(localStorage.getItem('cm.filter') ?? 'all');
  }
  ```
- **New** `library-grid.component.html` — semantic structure with grid container; CSS handles breakpoint-specific layout.
- **New** `library-grid.component.scss`:
  ```scss
  .grid {
    display: grid;
    /* Phone default */
    grid-template-columns: repeat(3, 1fr);
    gap: 2px;
    padding: 0 2px;
  }
  @media (min-width: 768px) {
    .grid {
      grid-template-columns: repeat(5, 1fr);
      gap: 4px;
      padding: 0 8px;
    }
  }
  @media (min-width: 1025px) {
    .grid {
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 4px;
      padding: 0 12px;
    }
  }
  ```
- **New** `library-cell.component.{ts,html,scss}` — single cell with thumbnail + badges.
- **New** `library-page.component.ts` in each app (`maple` and `maple-syrup`) — route component that renders `<app-library-grid>`. Replaces the S1a phone-library stub.

### Filter chip row

Standalone `<app-filter-chips>` component, single-select, emits `filterChange` event. Active chip class applies `MapleTokens.primary` background + border. Use `MapleTokens.Motion.filterFade` (S0a) for the 120ms cross-fade animation on filter change.

### Hover affordance (desktop only)

CSS-only:

```scss
@media (min-width: 1025px) and (pointer: fine) {
  .library-cell:hover {
    outline: 1.5px solid var(--color-primary);
    outline-offset: -1.5px;
  }
}
```

---

## 5. Testing strategy

### Apple

- `XCTest` for filter logic: `LibraryGridFilterTests` — given a list of assets, asserts filtered output matches expected for each `cm.filter` value.
- `#Preview` blocks for `LibraryGrid`, `LibraryCell`, `FilterChipRow` at all three breakpoints.
- UITest goldens (`MapleUITests/SliderMatrixUITests`): canvas-only crops unaffected.

### Web

- `library-grid.component.spec.ts`: renders correct column count at each `LayoutService.layout()` value (stub the service); renders correct cell count from `LibraryStateService.filteredAssets`; tap cell emits `cellTap(assetId)`.
- `filter-chips.component.spec.ts`: active class on selected chip; emits `filterChange` on tap; cross-fade class toggles.
- Playwright e2e (`src/web/e2e/library-grid.spec.ts`): viewport-resize verification — load `/library`, resize to 375 → assert 3 columns; resize to 800 → 5 columns; resize to 1400 → ≥6 columns.

### Visual verification

`preview_start name="maple"`, `preview_resize` to mobile/tablet/desktop, `preview_screenshot` at each. Attach all three to PR.

### CI gates

- `bun run test` / `ng test Maple-common`
- `swift test`
- `xcodebuild` macOS + iPhone 17 Pro sim — `BUILD SUCCEEDED`
- File-size budget per `CONTRIBUTING.md`

---

## 6. Risks & open questions

### Risks

1. **`hasEdits` field on `AssetRef`** may not exist — audit at PR time. If missing, file a separate KTLO to add it (computed from sidecar presence/contents).
2. **Existing `BrowseGrid` refactor risk** — extracting `LibraryCell` touches a load-bearing file. Run full Apple UITest suite to catch any cell visual regression.
3. **Loupe push destination** doesn't exist until S4 lands — S2 leaves a `// TODO(S4)` placeholder on cell tap. PR description must note this.
4. **`filter-chips.component`** on web crossfade may be hard to test deterministically in jsdom — defer animation verification to Playwright e2e.

### Open questions

1. **PhotoKit asset thumbnails** on phone — existing iOS code uses `PHCachingImageManager`; phone should reuse to keep performance budget (per CLAUDE.md "16ms slider, one frame open"). Verify caching is wired in `LibraryCell` at PR time.
2. **Wide-gamut canvas-color** in cell thumbnails on web — `webgl-pipeline.ts` tags drawing buffer as `srgb`; cell thumbnails should preserve that. Verify in PR.
