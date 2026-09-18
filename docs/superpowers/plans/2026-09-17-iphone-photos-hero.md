# iPhone Photos-style Preview hero — repair plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On iPhone, tapping a grid tile grows the photo out of that tile into Preview, and pulling down shrinks it back into the _current_ photo's tile with the grid visible beneath — one continuous motion, chrome fading, no duplicate image, no safe-area glitch — and the grid pinches between square tiers exactly like Photos.

**Architecture:** A hand-rolled `PreviewHero` overlay (already written) hosts Preview above the Library tab's `NavigationStack` with the grid live beneath. Three wiring faults on device make it look broken; this plan fixes them and removes the two things the Photos recording showed are wrong (native-aspect 1-column tier; the dead system zoom transition code). No new concepts.

**Tech Stack:** SwiftUI (iOS 26 deployment target, tested on iOS 27 device), UIKit `UIPageViewController` pager, XCTest in `MapleTests` (app target; never runs in CI — run locally).

**Spec:** the user's two screen recordings, extracted to contact sheets:

- Photos reference: `<scratchpad>/photos-open.png`, `photos-close.png`, `photos-pinch.png`
- Current Maple on device: `<scratchpad>/maple-open.png`, `maple-close.png`, `maple-pinch.png`

Observed requirements (from the Photos recording):

1. Open ≈ 0.35 s; the photo grows from the tile's rect to its aspect-fit rect, starting as the tile's square crop and uncropping; the **grid stays visible and dims**, and the tapped tile blanks while its photo is in flight; the header / filmstrip / action bar fade in over the last third.
2. Pull-down: the photo follows the finger and shrinks; chrome fades out in the first ~100 ms; the backdrop clears so the grid shows through; release past a threshold lands the photo **on its current tile**; release early springs back.
3. Pinch: square tiles at every tier, re-flowing continuously, the photo under the fingers held still.

## Global Constraints

- `IPHONEOS_DEPLOYMENT_TARGET = 26.0`; verify on the iOS 26.4 simulator (`iPhone 17 Pro`) AND on the user's iOS 27 device (`Artemis`, udid `DF4C2BA9-5520-5A8D-B521-CD6B46B49132`).
- The simulator wedges thumbnails with a warm cache: run `<scratchpad>/relaunch.sh` (clears `.maple/thumbs`) before every simulator launch.
- MapleTests never run in CI: run `xcodebuild test ... -only-testing:MapleTests/PreviewViewVMTests -only-testing:MapleTests/LibraryGridZoomTests` on `iPhone 17` (a second simulator) after every task that touches a VM file.
- `LEFTHOOK=0` on every commit (the swift-format hook is unsatisfiable). Never `git add -A`; stage explicit paths. No `Co-Authored-By` trailer.
- Restore `src/apple/Frameworks/RawPipeline.xcframework/Info.plist` (a build phase rewrites it) before every commit: `git checkout -- src/apple/Frameworks/RawPipeline.xcframework/Info.plist`.
- Files ≤ 600 lines (hard), keep `LibraryGrid.swift` under 570 (headroom gate).
- All paths below are relative to `src/apple/`.

`<scratchpad>` = `/private/tmp/claude-501/-Users-riabuz-Projects--Maple--claude-worktrees-maplecore-tests-optical-profiles-0d6fb9/47156c15-2c27-4240-919d-e2e77f324531/scratchpad`.

---

## File Structure

| File                                                                                                             | Responsibility after this plan                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Maple/Views/PreviewHero.swift`                                                                                  | The overlay: dimmed live grid beneath, hero still, Preview content fading in; open / close springs. Hosted at the **tab** level.                                                                                              |
| `Maple/Views/PhoneTabShell.swift`                                                                                | Hosts `PreviewHero` in an `.overlay` on the Library tab's `NavigationStack` (above the stack, inside the drawer). Owns `hero`, `heroTileFrame`, `heroClose` state. Keeps `pushedLibraryPath` (stack never pushes `.preview`). |
| `Maple/Views/PhoneLibraryView.swift`                                                                             | Back to a thin wrapper: no hero state, no overlay, no `.preview` destination.                                                                                                                                                 |
| `Maple/Views/LibraryGrid.swift`                                                                                  | Captures the tapped tile's frame **at tap time** and passes it up with the tap; keeps publishing the selected tile's live frame for paging; square tiles only.                                                                |
| `Maple/Views/Grid/PhotoGrid.swift`, `Grid/PhotoThumbnailCell.swift`, `Grid/ThumbnailImage.swift`                 | `onTap` gains the tile's window frame; `ThumbnailShape` removed (square always).                                                                                                                                              |
| `Maple/Views/LibraryGridZoom.swift`                                                                              | Tiers `[1, 2, 3, 4, 5, 7]`; `Geometry` loses the per-photo aspect table (all square).                                                                                                                                         |
| `Maple/Views/PreviewDestination.swift`, `PreviewView.swift`, `PreviewPager.swift`, `PreviewZoomController.swift` | Dead native-zoom code removed (`transitionProgress`, `isZoomDismissable`, `ZoomNavigationTransition`, crop transform, debug label). Pull-down stays Preview-owned.                                                            |
| `MapleTests/LibraryGridZoomTests.swift`, `MapleTests/PreviewViewVMTests.swift`                                   | Updated for the tier list and the removed helpers.                                                                                                                                                                            |

---

### Task 1: Hand the hero the tile frame at tap time

The hero currently reads `selectedTileFrame`, which is only published by the selected cell's `onGeometryChange` — one layout pass _after_ the tap sets `selectedID`. On device the hero starts before that arrives and falls into its "no tile → grow from centre" path (the "duplicate image" in the recording). Capture the frame in the tap itself.

**Files:**

- Modify: `Maple/Views/Grid/PhotoThumbnailCell.swift:60-68, 173, 179`
- Modify: `Maple/Views/Grid/PhotoGrid.swift:124-130, 176-190`
- Modify: `Maple/Views/LibraryGrid.swift:40, 136-143`
- Modify: `Maple/Views/AppShellCenterColumn.swift:104, 262`, `Maple/Views/AppShellIPhoneShell.swift:92, 158`, `Maple/Views/PhoneLibraryView.swift` (the `onOpenEditor` parameter), `Maple/Views/PhoneTabShell.swift:151, 266`

**Interfaces:**

- Produces: `PhotoThumbnailCell.onTap: (CGRect) -> Void` — the tile's window-space frame at the moment of the tap. `PhotoGrid.onTap: (Element, CGRect) -> Void`. `LibraryGrid.onOpenEditor: (AssetRef, CGRect) -> Void`. Every layer up to `PhoneTabShell` carries the rect; `PhoneTabShell.pushPreview(_:tileFrame:cloudSource:)` stores it.

- [x] **Step 1: Give the cell a frame at tap time.** In `PhotoThumbnailCell.swift` replace the `FrameReporter` modifier + the plain tap with one modifier that keeps the latest frame and reports it on tap:

```swift
  /// Cell tap handler. Receives the cell's frame in the window's
  /// coordinate space at the moment of the tap — the iPhone Preview hero
  /// grows out of exactly that rect.
  let onTap: (CGRect) -> Void
```

and replace `.modifier(FrameReporter(onFrameChange: onFrameChange))` … `.onTapGesture { onTap() }` with:

```swift
    .modifier(TapWithFrame(onTap: onTap, onFrameChange: onFrameChange))
```

and replace the `FrameReporter` struct with:

```swift
// MARK: - TapWithFrame

/// Tracks the view's window-space frame and hands it to `onTap`. The
/// frame is read through `onGeometryChange` (never a GeometryReader in
/// `body`, which would size the cell); the read is the same one the
/// optional `onFrameChange` publishes, so a cell pays for one watcher.
private struct TapWithFrame: ViewModifier {
  let onTap: (CGRect) -> Void
  let onFrameChange: ((CGRect) -> Void)?
  @State private var frame: CGRect = .zero

  func body(content: Content) -> some View {
    content
      .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .global) }) { new in
        frame = new
        onFrameChange?(new)
      }
      .onTapGesture { onTap(frame) }
  }
}
```

Keep `onFrameChange` as is (the selected cell still publishes live frames for paging).

- [x] **Step 2: Thread the rect through `PhotoGrid`.** `let onTap: (Element, CGRect) -> Void`; in the init `onTap: @escaping (Element, CGRect) -> Void`; in the `ForEach`: `onTap: { frame in onTap(element, frame) },`. Update the four `#Preview` blocks in `PhotoGrid.swift` and the five in `PhotoThumbnailCell.swift`: `onTap: { _ in }` / `onTap: { _, _ in }`.

- [x] **Step 3: Thread it through `LibraryGrid`.** `let onOpenEditor: (AssetRef, CGRect) -> Void`; the grid's `onTap: { asset, frame in … onOpenEditor(asset, frame) }`. In `pinchOverlay` the overlay cells use `onTap: { _ in }`.

- [x] **Step 4: Thread it through the shell layers.** `AppShellCenterColumn.onOpenEditor` and `AppShellIPhoneShell.onOpenEditor` become `(AssetRef, CGRect) -> Void` only for the phone `LibraryGrid` call site — add a NEW property `onOpenTile: (AssetRef, CGRect) -> Void = { _, _ in }` to both (so `BrowseGrid` and the Mac call sites keep `onOpenEditor`), wire `LibraryGrid(onOpenEditor: onOpenTile)`, and in `PhoneLibraryView` add `let onOpenTile: (AssetRef, CGRect) -> Void` passed through. In `PhoneTabShell` pass `onOpenTile: { asset, frame in pushPreview(asset, tileFrame: frame) }` and change `pushPreview`:

```swift
    private func pushPreview(_ asset: AssetRef, tileFrame: CGRect? = nil, cloudSource: (any ImageSource)? = nil) {
        cloudPreviewSource = cloudSource
        heroTileFrame = tileFrame
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            libraryPath.append(.preview(asset))
        }
    }
```

(`heroTileFrame` is declared in Task 2. All other `pushPreview` callers — Timeline, Search, Map — pass no frame and get the centre-grow fallback.)

- [x] **Step 5: Build.** `xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath <scratchpad>/dd build` → `BUILD SUCCEEDED`, then the macOS destination too (`BrowseGrid` call sites are shared).

- [x] **Step 6: Commit.** `git add` the seven touched files; message `fix(apple): capture the tapped tile's frame in the tap itself`.

---

### Task 2: Host the hero at the tab level, above the stack, with correct safe areas

The overlay currently lives on `PhoneLibraryView` (inside the stack's root), so a pushed editor covers it and the Library toolbar keeps drawing under Preview (the double header in the close recording). It also `ignoresSafeArea()` on the whole container then re-pads content with a stale inset (the low photo / missing header pill).

**Files:**

- Modify: `Maple/Views/PhoneTabShell.swift` (state + overlay on the Library tab)
- Modify: `Maple/Views/PhoneLibraryView.swift` (remove hero state, overlay, `.onChange(of: previewEntry)`, `previewContent`, `popPreview`, the two `.toolbar(hero == nil …)` lines; keep the `.navigationDestination` with `.edit` only)
- Modify: `Maple/Views/PreviewHero.swift`

**Interfaces:**

- Consumes: `heroTileFrame: CGRect?` (Task 1). `PreviewHero(subject:tileFrame:tileCornerRadius:content:onClosed:closeRequest:)` (existing).
- Produces: `PhoneTabShell.previewContent(for:)` builds `PreviewDestination` exactly as `PhoneLibraryView.previewContent` does today (move the code verbatim, including `onClose`/`onPullDownCommitted` → `heroClose`).

- [x] **Step 1: Move the hero state and overlay into `PhoneTabShell`.** Add:

```swift
    /// The photo the Preview hero is showing. Follows `libraryPath`'s
    /// `.preview` entry — the path stays the source of truth (Edit pushes
    /// on top of it, deep links seed it, the drawer gates on it); the hero
    /// is how that entry is drawn, ABOVE the tab's NavigationStack so the
    /// grid stays live beneath it and no toolbar of the stack's root is
    /// laid out under it.
    @State private var hero: PreviewHeroSubject?
    /// The tapped tile's window-space frame (Task 1) — where the hero
    /// grows from; nil for a Timeline / Search / deep-link push.
    @State private var heroTileFrame: CGRect?
    /// Live frame of the selected tile, for the close after paging.
    @State private var selectedTileFrame: CGRect?
    @State private var heroClose: PreviewHeroCloseRequest?
```

Wrap the Library tab's `NavigationStack(path: pushedLibraryPath) { PhoneLibraryView(…) }` in the `.overlay { if let hero { PreviewHero(...) .zIndex(1) } }` + `.onChange(of: previewEntry, initial: true) { … }` moved from `PhoneLibraryView` (same bodies; `tileFrame: heroTileFrame ?? selectedTileFrame` on open, and the hero's close uses `selectedTileFrame` — see Step 3). Pass `onSelectedTileFrameChange: { selectedTileFrame = $0 }` into `PhoneLibraryView` (it already threads it down).

- [x] **Step 2: Fix safe areas in `PreviewHero`.** Replace the `body` so the overlay fills the full window but Preview is laid out as a normal full-screen view (it applies its own safe-area handling exactly as it did when pushed):

```swift
    var body: some View {
        GeometryReader { geometry in
            // Full window, safe areas included, in this view's own space.
            let bounds = CGRect(origin: .zero, size: geometry.size)
            let fit = PreviewViewVM.fitRect(imageSize: subject.imageSize, in: bounds)
            let tile = tileFrame ?? CGRect(x: bounds.midX - 40, y: bounds.midY - 40, width: 80, height: 80)
            let start = phase == .closing ? (closeStart ?? fit) : fit
            let rect = PreviewViewVM.heroRect(from: tile, to: start, progress: progress)

            ZStack {
                MapleTokens.bg.opacity(Double(progress) * PreviewHeroMotion.dimAtOpen)

                content()
                    .opacity(phase == .open ? 1 : (phase == .closing ? 0 : contentOpacity))
                    .allowsHitTesting(phase == .open)

                if phase != .open {
                    heroStill(in: rect, progress: progress)
                }
            }
        }
        .ignoresSafeArea()
        …
```

`geometry` here is the safe-area-ignoring overlay, so `bounds` is in window space — the same space `tileFrame` (from `.global`) and the pager's `photoRectInWindow` use. **Do not** apply `safeAreaPadding` to `content()`: `PreviewView` already lays its header pill against the safe area via `.padding(.top, 8)` under `ignoresSafeArea` on its own ground only. Add `static let dimAtOpen: Double = 0.92` to `PreviewHeroMotion` — Photos leaves the grid faintly visible at full open.

- [x] **Step 3: Close lands on the current tile.** In the `.onChange(of: closeRequest)` handler the hero already springs `progress → 0` against `tile`. Since `tile` reads `tileFrame` and `PhoneTabShell` passes `heroTileFrame ?? selectedTileFrame` — after paging `selectedTileFrame` is newer — change the pass to prefer the selected tile whenever it exists: `tileFrame: selectedTileFrame ?? heroTileFrame`. `LibraryGrid` already scrolls the selected tile into view while covered.

- [x] **Step 4: Blank the source tile while its photo is in flight** (Photos does this). In `PhoneTabShell` derive `let heroInFlightID: AssetRef.ID? = hero == nil ? nil : hero?.asset.id` — pass it down as a new `PhoneLibraryView`/`AppShellIPhoneShell`/`AppShellCenterColumn`/`LibraryGrid` parameter `hiddenTileID: AssetRef.ID?` and in `LibraryGrid` apply `.opacity(asset.id == hiddenTileID ? 0 : 1)` on the cell (inside `PhotoGrid`'s cell closure via a new `PhotoGrid.isHidden: ((Element) -> Bool)?` — one line). Set it non-nil only while `phase != .open` — expose `PreviewHero`'s phase via an `onPhaseChange: (PreviewHeroPhase) -> Void` callback and keep `@State private var heroPhase` in `PhoneTabShell`.

- [x] **Step 5: Build (sim + macOS), then verify on the simulator.** Run `<scratchpad>/relaunch.sh`, start `<scratchpad>/rec.sh start heroC`, tap a tile at (200,183), wait 1.5 s, pull down (touch_path from y=420 to y=690), wait 1.5 s, stop. Cut `ffmpeg -ss <tap-0.1> -t 1.0 -vf "fps=40,scale=150:-1,tile=8x5"` for the open and the same around the pull. **Pass criteria:** the open sheet shows the still growing out of the tile over ~14 frames with the grid visible and dimming behind it, no second copy of the photo; the header pill is visible at the top after open; the close sheet shows the still shrinking into the same tile with the grid brightening. Screenshot the opened state and confirm the photo is vertically centred between the header pill and the filmstrip (not pushed down).

- [x] **Step 6: Commit.** `fix(apple): host the Preview hero above the Library stack with correct safe areas`.

---

### Task 3: Square tiles everywhere; Photos' tier list

The Photos recording shows square cells at every tier and more tiers than `[1,2,3,5]`. Remove the native-aspect 1-column mode (my misreading) and the per-photo row table.

**Files:**

- Modify: `Maple/Views/LibraryGridZoom.swift` (`columnTiers = [1, 2, 3, 4, 5, 7]`; delete `Geometry.init(width:count:aspects:)`'s aspect parameter and `rowTops` — every method falls through to the static square functions; keep the `Geometry` struct as a thin value so `LibraryGrid` needs no other change)
- Modify: `Maple/Views/LibraryGrid.swift` (delete `cellShape`, `fullWidthAspect(of:)`; `Geometry(width:count:)`; remove the `cellShape:` argument)
- Modify: `Maple/Views/Grid/ThumbnailImage.swift`, `Grid/PhotoThumbnailCell.swift`, `Grid/PhotoGrid.swift` (delete `ThumbnailShape`, `shape`, `cellShape`, `contentMode` computed var; restore `.aspectRatio(1, contentMode: .fit)` and `displayMode.contentMode`)
- Test: `MapleTests/LibraryGridZoomTests.swift`

- [x] **Step 1: Update the tests first.** Replace `testFullWidthRowsTakeEachPhotosAspect` and `testSquareGeometryMatchesTheStaticFunctions` with:

```swift
  func testTiersAreDenseAndSquare() {
    XCTAssertEqual(LibraryGridZoom.columnTiers, [1, 2, 3, 4, 5, 7])
    let g = LibraryGridZoom.Geometry(width: width, count: 24)
    for columns in LibraryGridZoom.columnTiers {
      let r = g.cellRect(index: 7, columns: columns)
      XCTAssertEqual(r.width, r.height, accuracy: 1e-9, "tier \(columns) must be square")
      XCTAssertEqual(r, LibraryGridZoom.cellRect(index: 7, columns: columns, width: width))
      XCTAssertEqual(g.gridHeight(columns: columns), LibraryGridZoom.gridHeight(count: 24, columns: columns, width: width), accuracy: 1e-9)
    }
  }
```

Update `testPinchOutWalksTowardFewerColumns` / `testPinchInWalksTowardMoreColumns` / `testNearestTierAndStoredValidation` for the new neighbours: 3→2 and 2→1 still hold; 3's pinch-in neighbour is now **4** (not 5) — change `to: 5` to `to: 4` and recompute `m` against `cellSize(columns: 4)`; `validatedColumns(4)` now returns 4 — assert `validatedColumns(6) == 3` instead.

- [x] **Step 2: Run the tests → expect the tier assertions to FAIL** (`xcodebuild test … -only-testing:MapleTests/LibraryGridZoomTests` on `iPhone 17`).

- [x] **Step 3: Implement.** Tier list; delete the aspect machinery listed above.

- [x] **Step 4: Run the tests → PASS.** Build iOS + macOS.

- [x] **Step 5: Verify pinch on the simulator** (`relaunch.sh`, record, pinch in from 3 with fingers at (130,500)/(270,500) closing to (185,500)/(215,500) over 8 steps, then pinch out). Pass: tiles stay square at every intermediate frame; the focal photo does not move; the settled grid matches the last overlay frame.

- [x] **Step 6: Commit.** `feat(apple): Photos' square tiers 1/2/3/4/5/7 for the iPhone grid`.

---

### Task 4: Remove the dead native-zoom path

`.navigationTransition(.zoom)` never runs on the iOS 27 device and the hero replaces it. Remove it so Preview has one open/close mechanism.

**Files:**

- Modify: `Maple/Views/PreviewDestination.swift` (delete `transitionNamespace`, `fullSize`, `liveSize`, `transitionProgress`, `ZoomNavigationTransition`, the `.background { … onGeometryChange }`, `isZoomDismissable:`; header comment rewritten to describe the hero)
- Modify: `Maple/Views/PreviewView.swift` (delete `transitionProgress`, `isZoomDismissable`, `isPulling`, the `#if DEBUG` label overlay; `bottomChromeHeight` padding becomes constant; `chromeOpacity` = `plainPullChromeOpacity` only)
- Modify: `Maple/Views/PreviewPager.swift` (delete `transitionProgress`, `isZoomDismissable`, `onPullActiveChanged`, `setTransitionProgress`; the gate always drives the plain pull)
- Modify: `Maple/Views/PreviewZoomController.swift` (delete `transitionProgress`, `transitionCropScale`, `refinementDeferredByTransition`, `setTransitionProgress`, `applyTransitionCrop`, and the deferred-refinement guard in `requestRefinement`)
- Modify: `Maple/Views/PreviewView+VM.swift` (delete `zoomTransitionProgress`, `zoomSettledTolerance`, `zoomSettledProgress`, `zoomNearSquareDelta`, `zoomTransitionChromeOpacity`, `zoomChromeFadeStart`)
- Modify: `Maple/Views/PhoneLibraryView.swift`, `AppShellIPhoneShell.swift`, `AppShellCenterColumn.swift`, `LibraryGrid.swift`, `PhotoGrid.swift`, `PhotoThumbnailCell.swift` (delete `previewTransitionNamespace` / `transitionNamespace` / `ZoomSourceTag` plumbing; the `@Namespace` in `PhoneLibraryView`)
- Modify: `Maple/Views/PhoneSearchTab.swift` (`PreviewDestination` call drops nothing — it never passed the namespace; confirm it compiles)
- Test: `MapleTests/PreviewViewVMTests.swift` (delete the three `testZoom…` tests)

- [x] **Step 1: Delete the tests, run → the suite must still compile** (they only referenced removed helpers).
- [x] **Step 2: Delete the code above.** Build iOS + macOS: `0 errors`.
- [x] **Step 3: Run both unit suites → PASS.**
- [x] **Step 4: Re-run the Task 2 Step 5 simulator check** (open + pull-down) — behaviour unchanged.
- [x] **Step 5: Commit.** `refactor(apple): drop the unused system zoom transition path from Preview`.

---

### Task 5: Device verification and PR update

- [x] **Step 1: Build for Artemis** (`-destination 'platform=iOS,name=Artemis' -allowProvisioningUpdates -derivedDataPath <scratchpad>/dd-device`), install with `xcrun devicectl device install app --device DF4C2BA9-5520-5A8D-B521-CD6B46B49132 <app>`, launch with `… process launch --terminate-existing … app.justmaple.aperture`.
- [x] **Step 2: Ask the user for a screen recording** of tap-open → page twice → pull-down, and pinch in/out. Extract sheets with `ffmpeg -vf "fps=30,scale=150:-1,tile=8x6"` and compare against `photos-open.png` / `photos-close.png` / `photos-pinch.png`. Pass: no duplicate image during open; header pill visible; grid visible and dimming beneath the open; close lands on the _paged-to_ tile; square tiles through the pinch.
- [x] **Step 3: Run `bash tools/check-file-budget.sh`, `bash tools/check-budget-headroom.sh`** from the repo root; both clean.
- [x] **Step 4: Push**, wait for CI on PR #3740 (26 checks), read the Jules review comment, address any finding, and update the PR description's "What this does" paragraph: replace the "`.navigationTransition(.zoom)`" sentence with "a hand-rolled hero overlay above the Library stack (the system zoom transition does not run on iOS 27)". Update `docs/features.md`'s iPhone sentence to drop the "1-column tiles take each photo's aspect" claim.
