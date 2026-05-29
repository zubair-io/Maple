# Responsive Program — S4: Loupe / Full Image

Fourth sub-project of the responsive program (epic [#577](https://github.com/zubair-io/Maple/issues/577)). Full-screen single-image view with zoom/pan/swipe and auto-hiding chrome. Pushed from a grid cell tap in any tab's NavStack. Depends on S0a (`MapleLayout`), S1a (tab-bar hide pattern), S1c (bottom-sheet for Info modal), and S2 (cell tap origin).

Visual reference: `/Users/riabuz/Projects/_Maple/mobile/Maple Mobile Editor.html` frame **03 · Full image (loupe)**, plus prompt §5.4.

One ticket — **S4** — shipped as one PR.

---

## 1. Overview & deliverable map

| Ticket | What ships                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Files touched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Blocks                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **S4** | Responsive `LoupeView` (full-screen image with auto-hiding chrome, zoom/pan, swipe-between, matched-geometry dismiss). On phone, push from any tab's grid; tab bar hidden via S1a pattern. On tablet/desktop, replaces existing `FullImage` view's pane-shell center column. Filmstrip (shared with S5) on tablet/desktop default-on, phone toggleable via `cm.filmstrip`. Info `i` icon opens `mapleBottomSheet` (S1c) on phone, expands existing Inspector pane (S6) on tablet/desktop. Edit pill pushes to S5. | New `src/apple/Maple/Views/LoupeView.swift`, new `src/apple/Maple/Views/FilmstripView.swift` (shared with S5), `src/apple/Maple/Views/PhoneLibraryView.swift` (S2 — wires `.navigationDestination`), edits to `src/apple/Maple/Views/AppShellMacLayout.swift` (pane-shell Loupe surface), new `src/web/projects/maple-common/src/lib/loupe/loupe.component.{ts,html,scss,spec.ts}`, new `src/web/projects/maple-common/src/lib/loupe/filmstrip.component.{ts,html,scss,spec.ts}`, `src/web/projects/maple/src/app/loupe-page.component.ts`, `src/web/projects/maple-syrup/src/app/loupe-page.component.ts` | S5 (Editor pushes from Loupe Edit pill) |

S4 depends on:

- S0a — `MapleLayout` env
- S1a — `TabBarVisibilityService` for tab-bar hide on push
- S1c — `mapleBottomSheet` for Info modal
- S2 — cell tap source in grid

S4 unblocks S5.

---

## 2. Visual reference & behavior

### Phone

- **Status bar** is the only persistent chrome.
- **Image** letterboxed against `MapleTokens.imageCanvas` (`#141210` — distinct from `bg`).
- **Header overlay** (transient): tap toggles visible; auto-hides after **2.5s** of inactivity (180ms fade — `MapleTokens.Motion.chromeHide` from S0a). L→R: back chevron · filename (SF Mono 12pt — `MapleTokens.Typography.filename`) · share icon (stub) · "Edit" pill (accent fill, pushes to S5) · info icon (opens S1c bottom-sheet).
- **Optional filmstrip** (bottom row, persisted via `cm.filmstrip`): 44×44 thumbs, 4pt gaps, scroll-snap-center. Active thumb gets 1.5pt accent **inset** outline.
- **Gestures**:
  - Single tap → toggle chrome
  - Double tap → 1× ↔ 2.5× zoom centered on tap point
  - Pinch → free zoom `[1, 6]`; pan applies above 1×
  - Swipe horizontal → previous/next image in filtered list (snap; no carousel preview)
  - Swipe down → dismiss to grid; threshold velocity ≥ 1200 px/s OR distance ≥ 25% screen height. **Image scales toward its origin grid cell** (matched geometry on iOS via `matchedGeometryEffect`; FLIP technique on web with `getBoundingClientRect()`).

### Tablet

- Loupe occupies main pane (sidebar + main + collapsible inspector still visible). No auto-hiding chrome — header is persistent.
- Filmstrip always-on at this size (more vertical room).
- `i` icon opens/closes the Inspector pane (S6) — not the bottom sheet.

### Desktop

- Same as tablet but wider; keyboard shortcuts (per §5b.5):
  - `←`/`→` previous/next
  - `Esc` exit Loupe (pops back to grid)
  - `E` enter editor
  - `0` fit to viewport, `1` 100% zoom (existing on desktop; preserve)
- Hover affordances on cell hover (existing).

---

## 3. Apple implementation

### `LoupeView.swift` (new)

```swift
struct LoupeView: View {
    @Environment(\.mapleLayout) private var layout
    let asset: AssetRef
    let filteredAssets: [AssetRef]  // for swipe-between
    @State private var chromeVisible = true
    @State private var chromeHideTask: Task<Void, Never>?
    @State private var isInfoOpen = false
    @State private var zoom: CGFloat = 1.0
    @State private var panOffset: CGSize = .zero
    @AppStorage("cm.filmstrip") private var filmstripVisible: Bool = false

    var body: some View {
        ZStack {
            MapleTokens.imageCanvas.ignoresSafeArea()

            LoupeCanvas(asset: asset, zoom: $zoom, panOffset: $panOffset)
                .gesture(/* pinch, pan, double-tap, swipe */)
                .onTapGesture { toggleChrome() }
                .matchedGeometryEffect(id: asset.id, in: gridAnimationNamespace, isSource: false)

            if chromeVisible || layout != .phone {
                LoupeHeader(
                    // `AssetRef` exposes `displayName` (derived from primaryURL
                    // or an explicit override) — there is no `filename`
                    // property on the current model. Use `displayName` so the
                    // sample compiles against `MapleCore` as shipped.
                    title: asset.displayName,
                    onBack: { /* pop nav */ },
                    onEdit: { /* push to S5 EditorView */ },
                    onInfo: { isInfoOpen.toggle() }
                )
            }

            if filmstripVisible || layout != .phone {
                FilmstripView(assets: filteredAssets, current: asset)
            }
        }
        .toolbar(.hidden, for: .tabBar)  // S1a pattern — phone only; no-op on Mac
        .mapleBottomSheet(isPresented: $isInfoOpen) {
            InfoSheetContent(asset: asset)  // S6 supplies the body
        }
        .onAppear { startChromeHideTimer() }
    }

    private func toggleChrome() {
        withAnimation(MapleTokens.Motion.chromeHide) {
            chromeVisible.toggle()
        }
        if chromeVisible { startChromeHideTimer() }
    }
    private func startChromeHideTimer() {
        chromeHideTask?.cancel()
        chromeHideTask = Task {
            try? await Task.sleep(for: .seconds(2.5))
            withAnimation(MapleTokens.Motion.chromeHide) { chromeVisible = false }
        }
    }
}
```

### `FilmstripView.swift` (shared with S5)

44×44 thumbnails in a horizontal `ScrollView` with `.scrollTargetBehavior(.viewAligned)`. Active thumb has a 1.5pt accent inset overlay. Scrolling to the active thumb is automatic.

### Matched-geometry dismiss

Use a shared `@Namespace` for `matchedGeometryEffect` between `LibraryCell` (S2) and `LoupeCanvas`. Swipe-down with velocity ≥ 1200 px/s OR distance ≥ 25%h pops the nav stack with an animation that scales the LoupeCanvas back into the cell's bounding rect.

### Pane shell integration

Existing `AppShellMacLayout.swift` already has a Full-image mode in the center pane. S4 replaces that view body with `LoupeView()` so the same code renders on Mac/iPad/desktop browser. Inspector pane toggle (`i` icon) goes through `cm.detailHidden` (existing S0 schema).

---

## 4. Web implementation

### `loupe.component.ts` (new)

Standalone Angular component, signals. Inputs: `asset` and `filteredAssets`. Renders the canvas + chrome + filmstrip + info modal.

Tab-bar hide on enter:

```ts
constructor() {
  effect(() => {
    this.tabBarVisibility.hidden.set(true);  // S1a service
  });
}
ngOnDestroy() {
  this.tabBarVisibility.hidden.set(false);
}
```

Auto-hide chrome on phone via signal + RxJS-free `setTimeout` reset on tap.

Gestures via PointerEvents directives — write inline rather than pulling a library. Pinch/pan/double-tap/swipe handlers. Velocity tracking via 100ms window.

Matched-geometry dismiss (FLIP technique):

```ts
private animateDismissToCell() {
  const cellRect = this.libraryState.getCellRect(this.asset().id);  // grid cell bounding rect cached
  const loupeRect = this.canvas.nativeElement.getBoundingClientRect();
  const scaleX = cellRect.width / loupeRect.width;
  const scaleY = cellRect.height / loupeRect.height;
  const translateX = cellRect.left - loupeRect.left;
  const translateY = cellRect.top - loupeRect.top;
  this.canvas.nativeElement.animate(
    [{ transform: 'none' }, { transform: `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})` }],
    { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }
  );
  setTimeout(() => this.router.navigate(['..']), 240);
}
```

### `filmstrip.component.ts` (shared with S5)

Horizontal scroll, `scroll-snap-type: x mandatory`, 44px square thumbs, 4px gaps, 1.5px inset outline on active.

### Loupe page

`src/web/projects/maple/src/app/loupe-page.component.ts` and same in `maple-syrup` — route component for `/library/loupe/:id` (and `/search/loupe/:id` etc. for other tabs). Reads `:id` from `ActivatedRoute`, fetches `AssetRef` via `LibraryStateService`, renders `<app-loupe>`.

### Keyboard shortcuts (desktop only)

`@HostListener('window:keydown', ['$event'])` — `ArrowLeft`/`ArrowRight` swap asset; `Escape` navigates back; `e` pushes to editor. Only active when `LayoutService.layout() === 'desktop'`.

---

## 5. Testing strategy

### Apple

- `XCTest`:
  - `LoupeViewGestureTests` — given a tap, asserts `chromeVisible` toggles; given a `Task.sleep(2.6)`, asserts auto-hide.
  - `LoupeViewZoomTests` — pure zoom math (clamp at 1..6, double-tap toggles 1↔2.5).
- `#Preview` for `LoupeView`, `LoupeHeader`, `FilmstripView` at phone + desktop layouts.
- UITest goldens: existing canvas-crop tests unaffected; consider new chrome-included golden for Loupe in a follow-up.

### Web

- `loupe.component.spec.ts`: tap toggles chrome (signal asserted); after 2.5s timer (use `fakeAsync` + `tick`), chrome hidden; tab-bar visibility service called with `true` on init, `false` on destroy.
- `filmstrip.component.spec.ts`: renders thumbs from `assets` input; active thumb has `.active` class; clicking thumb emits `select(assetId)`.
- Playwright e2e (`src/web/e2e/loupe.spec.ts`): full flow — load `/library`, click cell, assert URL is `/library/loupe/:id`, verify chrome auto-hides after 2.5s, swipe down dismisses with FLIP.

### CI gates

Same as S0/S1 baseline.

---

## 6. Risks & open questions

### Risks

1. **Matched-geometry on web (FLIP)** requires the cell's `boundingClientRect` to be cached at navigation time — `LibraryStateService` needs a `getCellRect(id)` method. Adds coupling between grid and loupe; document in PR.
2. **Pinch-zoom on web** — PointerEvents pinch is tricky to handle correctly (two simultaneous pointers, velocity calc). Allocate review time. Reference impl: existing `zoom.ts` (per CLAUDE.md `docs/zoom.md`).
3. **Auto-hide chrome** can race with manual taps near the 2.5s boundary — debouncing matters. Test with rapid taps.
4. **Filmstrip thumbnail loading** on phone (44pt) — reuse existing thumb cache; phone uses smaller thumb sizes to keep memory bounded.
5. **Pane shell integration** — existing `AppShellMacLayout` Full-image branch already does most of what S4 needs on desktop. The refactor risk is collapsing two slightly-different surfaces into one `LoupeView`. Run full UI smoke test on Mac after.

### Open questions

1. **Filmstrip filter behavior** — when in `Picks` filter mode, does swipe-between cycle only picks or all assets? Spec implies the filtered list. Confirm at PR time.
2. **Zoom-state persistence** — per `docs/spec/07-ui-architecture.md` § "Zoom and pan", zoom resets on navigation in v1. Phase 3 adds "pin zoom" preference. S4 honors v1 (reset).
3. **Existing `FullImage` component on desktop** — if its API differs significantly from `LoupeView`, file a follow-up to unify rather than maintain two. Audit at PR time.
