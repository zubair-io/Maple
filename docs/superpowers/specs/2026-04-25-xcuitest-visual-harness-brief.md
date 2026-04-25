# XCUITest visual-regression harness (brainstorm brief)

> Companion to the Rust color-pipeline harness at
> [`src/scripts/test_color_pipeline.sh`](../../../src/scripts/test_color_pipeline.sh)
> + [`src/scripts/compare_images.py`](../../../src/scripts/compare_images.py).
> That harness gates `maple-cli` PNG output against embedded DNG previews via
> CIEDE2000. This brief designs an end-to-end shell-driven equivalent that
> screenshots the live SwiftUI canvas after `EditSession`'s refine pass, and
> gates it against committed goldens with the same metric.

## 1. Target setup

No UITests target exists today —
[`pbxproj:175-178`](../../../src/apple/Maple.xcodeproj/project.pbxproj)
declares only `Maple` and a `MapleTests` unit-test stub. Add a third
target: `com.apple.product-type.bundle.ui-testing` with
`PRODUCT_BUNDLE_IDENTIFIER = app.justmaple.maple.UITests`,
`TEST_TARGET_NAME = Maple`, dependency on `Maple` (mirroring
[`pbxproj:258-262`](../../../src/apple/Maple.xcodeproj/project.pbxproj)).
Sources at `src/apple/MapleUITests/`:
`MapleUITests.swift` (XCTestCase entrypoint), `Helpers/MapleAppDriver.swift`,
`Helpers/CIEDE2000.swift`, `Goldens/<fixture>-<state>.png`. Use a
`PBXFileSystemSynchronizedRootGroup` (matches `Maple` at
[`pbxproj:30-36`](../../../src/apple/Maple.xcodeproj/project.pbxproj)) so
new files auto-track.

## 2. Fixture access

UITest runs in a separate process; the SUT runs sandboxed
([`pbxproj:405,475`](../../../src/apple/Maple.xcodeproj/project.pbxproj)).
Options: (a) launch arg with absolute path — sandbox blocks unless we
add a `files.user-selected.read-only` entitlement (fragile);
(b) bundle resources copied to Documents — bloats the test bundle past
GitHub's file-size limit on the 100MP fixture; (c) absolute repo path
via env var — works only on local dev; (d) `MAPLE_UITEST_FIXTURE` env
var consumed by `MapleApp.init`, which seeds `BrowseViewModel` directly
with a one-asset library, bypassing the picker.

**Recommend (d).** ~15-line hook in
[`MapleApp.swift:13-26`](../../../src/apple/Maple/MapleApp.swift) gated
on `#if DEBUG`. `ProcessInfo.processInfo.environment` survives the
sandbox; `AUTOMATION_APPLE_EVENTS = NO` and the various `RUNTIME_EXCEPTION_*`
flags govern Apple Events / DYLD only, not plain env vars. Path resolves
against the repo root in dev; CI mirrors via `MAPLE_UITEST_FIXTURE_ROOT`.

## 3. Accessibility wiring

Today, from `grep -rn accessibilityLabel src/apple/Maple/`:
[`LibrarySidebar.swift:121,394,502,651`](../../../src/apple/Maple/Views/LibrarySidebar.swift)
(Add folder, sidebar buttons, folder display name),
[`AppShell.swift:213,222`](../../../src/apple/Maple/Views/AppShell.swift)
(Back to Library, Search),
[`BrowseGrid.swift:129`](../../../src/apple/Maple/Views/BrowseGrid.swift)
(Folder cell label),
[`FullImageView.swift:281,290,310`](../../../src/apple/Maple/Views/FullImageView.swift)
(Zoom out / in / indicator). Missing for the harness:

- **Canvas render-ready sentinel.** `EditSession.isRendering` flips false
  when refine publishes
  ([`EditSession.swift:1063,1089,1094,1116,1127`](../../../src/apple/Packages/MapleCore/Sources/MapleCore/EditSession.swift)).
  Add `accessibilityIdentifier("canvas-render-ready")` on the `CIImageView`
  at [`FullImageView.swift:146-150`](../../../src/apple/Maple/Views/FullImageView.swift),
  conditional on `!session.isRendering && session.renderedPreview != nil`.
  Test waits via `expectation(for: NSPredicate(format: "exists == 1"))`.
- **Thumbnail identifiers.** `ThumbnailCell` at
  [`BrowseGrid.swift:258-313`](../../../src/apple/Maple/Views/BrowseGrid.swift)
  has none — cells addressable only by index. Add
  `accessibilityIdentifier("thumb-\(asset.displayName)")` so a test picks
  `app.cells["thumb-test_0017"]`.
- **Slider names.** Each `AdjustSlider` at
  [`DetailPanel.swift:216-257,289-312`](../../../src/apple/Maple/Views/DetailPanel.swift)
  has a label string but no identifier. Add
  `accessibilityIdentifier("slider-\(label.lowercased())")`.

## 4. Screenshot strategy

`XCUIScreen.main.screenshot()` returns the whole display; we want
canvas-only because chrome (toolbar vibrancy, rounded corners, hover
states) magnifies frame-to-frame noise. Use
`app.otherElements["canvas-render-ready"].screenshot()` which crops to
the element frame. Round-trip the `XCUIScreenshot.image` to PNG via
`CGImageDestinationCreateWithURL` + `kUTTypePNG`; goldens commit to
[`test-fixtures/golden-screenshots/`](../../../test-fixtures) — sibling
to `raws/` (gitignored at the `raws/` level only, so PNG goldens commit).

## 5. Comparison

Two paths: shell out to `compare_images.py` (slow, identical math —
`colour.delta_E(method="CIE 2000")` at
[`compare_images.py:55`](../../../src/scripts/compare_images.py)) or
port the math to Swift. **Recommend a Swift port.** ~80 lines: sRGB→XYZ
→Lab via the D65 2° observer Bradford-adapted matrices, then standard
CIEDE2000. Cross-validate by running it against `compare_images.py` on
a fixed PNG pair in a Task 4 unit test — divergence > 1e-3 ΔE flags a
port bug. Apple's vImage has `vImageConvert_RGBToLab` but only iOS 16+
for the in-place form; pure Swift is portable.

## 6. Golden generation

First run, no baseline: write the golden, fail the test with a "baseline
written, please verify" message. Subsequent runs diff. Regenerate by
deleting the golden + re-running. Same workflow as
`pointfreeco/swift-snapshot-testing`.

## 7. Tolerance budget

Slider-tick goes through Lanczos at the canvas blit + display compositor
+ AgX view transform — exact-pixel match isn't realistic. Mirror the
existing harness's mean/p95/max gating at
[`test_color_pipeline.sh:48-51`](../../../src/scripts/test_color_pipeline.sh):
mean ΔE ≤ 5, p95 ≤ 10, max ≤ 30 (looser than the Bayer 15 mean is
unnecessary because the canvas-only crop excludes chrome — but tighter
than 15 because the input pair is the same scene at the same render,
not pipeline-vs-Adobe). Calibrate by running 3× against a fresh golden;
the budget's noise floor is the 95th-percentile run-to-run drift.

## 8. Slider matrix

Follow-up: exposure {-2, 0, +2}, contrast {0, +50}, sharpening {0, +100},
nr-luminance {0, +50}, dehaze {0, +50}. ~12 states × 3 fixtures = ~36
goldens. The test drives sliders via
`app.sliders["slider-exposure"].adjust(toNormalizedSliderPosition: 0.75)`
(XCUITest's only setter; positions are [0,1] over the range), waits on
`canvas-render-ready`, screenshots. Per-fixture × per-slider-set goldens.

## 9. CI plumbing

Local invocation:

```bash
xcodebuild test \
  -project src/apple/Maple.xcodeproj \
  -scheme Maple \
  -destination 'platform=macOS' \
  -only-testing:MapleUITests \
  MAPLE_UITEST_FIXTURE_ROOT="$PWD/test-fixtures/raws"
```

CI without fixtures: detect missing `MAPLE_UITEST_FIXTURE_ROOT` (or
files inside) at setup, call `XCTSkip("fixtures absent")` — soft pass,
mirrors the harness at
[`test_color_pipeline.sh:82-98`](../../../src/scripts/test_color_pipeline.sh).
xcframework rebuild already runs in the project's
[`pbxproj:219-237`](../../../src/apple/Maple.xcodeproj/project.pbxproj)
"Build Rust xcframework" phase; UITest target inherits app build.

## 10. Recommended cut

UITests target + accessibility identifiers + ONE test on `test_0017.dng`
at default sliders, comparing screenshot to a committed golden via Swift
CIEDE2000 port. No matrix, no other fixtures. 6 tasks. The slider matrix
and additional fixtures (`test_0000`, `test_0007`) follow as a milestone
— zero new architecture, only N more goldens and N more `XCTestCase`
methods. The biggest unknown — the pbxproj edit for the new
`com.apple.product-type.bundle.ui-testing` target — gets a dedicated
preflight-with-fallback in plan Task 1.
