# XCUITest visual-regression harness — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Brief:** [`docs/superpowers/specs/2026-04-25-xcuitest-visual-harness-brief.md`](../specs/2026-04-25-xcuitest-visual-harness-brief.md). The brief picks (a) a `MAPLE_UITEST_FIXTURE` env var read by `MapleApp.init` to seed the active library, (b) accessibility identifiers added on the canvas / thumbnails / sliders, (c) a Swift port of CIEDE2000 cross-validated against [`compare_images.py`](../../../src/scripts/compare_images.py), and (d) a budget of mean ΔE ≤ 5 / p95 ≤ 10 / max ≤ 30 calibrated empirically from 3 runs. § 10 picks the smallest first cut — one fixture (`test_0017.dng`), default sliders, one golden.

> **Companion harness:** [`src/scripts/test_color_pipeline.sh`](../../../src/scripts/test_color_pipeline.sh) and [`src/scripts/compare_images.py`](../../../src/scripts/compare_images.py) — same metric, different scope (Rust CLI PNG vs UI screenshot). The CIEDE2000 port in Task 4 is the integration point; harness commands stay invocable independently.

**Goal:** A single end-to-end `MapleUITests` test that:

1. launches Maple with `MAPLE_UITEST_FIXTURE=…/test_0017.dng`,
2. navigates to Full-image mode on that asset,
3. waits for `canvas-render-ready` (refine pass complete),
4. screenshots the canvas element,
5. compares it via Swift CIEDE2000 against `test-fixtures/golden-screenshots/test_0017-default.png`,
6. passes when mean ≤ 5, p95 ≤ 10, max ≤ 30; fails (with the diff JSON) otherwise; first run records the golden and fails with a "baseline written" message.

**Architecture:**

1. **One env var, one app-init hook.** Per brief § 2, `MAPLE_UITEST_FIXTURE` is the only test-only seam. [`MapleApp.swift:13-26`](../../../src/apple/Maple/MapleApp.swift) reads it inside a `#if DEBUG` block and routes the path through a new `BrowseViewModel.loadSingleAsset(url:)` so the picker doesn't fire and the sandbox doesn't get involved (env-var-resolved file URLs work without security scope when the file is reachable from the running user).

2. **Accessibility identifiers, not labels.** Per brief § 3, the harness needs identifiers (machine-stable) not labels (user-facing strings that change with localisation). New identifiers: `canvas-render-ready` on the canvas (`FullImageView`), `thumb-<displayName>` on each `ThumbnailCell`, `slider-<lowercased label>` on each `AdjustSlider`, `browse-grid` on the `LazyVGrid`. Existing labels stay; identifiers are additive.

3. **Swift CIEDE2000 port at `MapleUITests/Helpers/CIEDE2000.swift`.** Per brief § 5, ~80 lines of pure Swift. Cross-validated by a Task 4 unit test against `compare_images.py` on a known PNG pair (use the existing color-pipeline harness's WORKDIR layout, two PNGs stored as test fixtures). Passes on agreement to ≤ 1e-3 ΔE.

4. **Golden read/write at `MapleUITests/Helpers/GoldenStore.swift`.** Resolves goldens against `MAPLE_UITEST_GOLDENS_ROOT` (defaults to `<repo>/test-fixtures/golden-screenshots`). First-write fails the test with a `XCTFail("baseline written…")` message. `MAPLE_UITEST_RECORD=1` forces re-record (deferred to follow-up; not in v1).

5. **Test-bundle skip on missing fixtures.** Per brief § 9, `setUp` resolves the fixture path; missing → `XCTSkip("fixtures absent")` to mirror `test_color_pipeline.sh`'s "no fixtures, skipping" pattern. Documented in `docs/testing.md` (which doesn't exist yet — Task 6 creates it next to existing test docs).

**Tech stack:**

- Xcode/SwiftUI — new UI test target type `com.apple.product-type.bundle.ui-testing`.
- Swift 5.10 (matches [`pbxproj:330`](../../../src/apple/Maple.xcodeproj/project.pbxproj)) for tests + helpers; macOS 14.0 deployment target ([`pbxproj:320`](../../../src/apple/Maple.xcodeproj/project.pbxproj)).
- XCUITest framework: `XCUIApplication`, `XCUIElement`, `XCUIScreenshot`, `XCTSkip`.
- CoreGraphics + ImageIO for PNG round-trip.
- No new external dependencies. The Python harness stays as-is for parity validation only.

**Out of scope (explicit):**

- iOS / iPad UITest. UITest target supports both platforms (`SUPPORTED_PLATFORMS = "iphoneos iphonesimulator macosx"`), but the iOS simulator slice of `RawPipeline.xcframework` is arm64-only (CLAUDE.md § Build & test — Apple) and the simulator destinations need different setup. Add iOS in a follow-up.
- Slider matrix tests. Per brief § 10, follow-up milestone after v1 lands.
- Multi-fixture parameterised tests. Single test on `test_0017.dng` only for v1.
- CI pipeline integration (workflow YAML, runner provisioning). Local invocation documented; CI pipelining is a separate ticket.
- `MAPLE_UITEST_RECORD=1` re-record env var. Delete-the-golden is enough for v1.

---

## Task 1: Add UITests target to `Maple.xcodeproj/project.pbxproj`

> **Highest-risk task.** pbxproj is finicky — Xcode regenerates IDs, and a malformed file bricks the project. The fallback path uses Xcode's UI to add the target and inspect the generated diff before hand-editing.

- [ ] **Step 1.1: Capture a backup of the current `project.pbxproj`.**
      `bash
    cp src/apple/Maple.xcodeproj/project.pbxproj /tmp/maple-pbxproj.backup
    `
      Verify: `wc -l /tmp/maple-pbxproj.backup` reports 626 lines.

- [ ] **Step 1.2: Confirm the project still parses with the existing target list.**
      `bash
    xcodebuild -project src/apple/Maple.xcodeproj -list
    `
      Verify: output includes `Maple` and `MapleTests` targets, no errors.

- [ ] **Step 1.3: Hand-edit `project.pbxproj` to add `MapleUITests`.** Pattern: clone the existing `MapleTests` target sections (PBXNativeTarget at [`pbxproj:120-139`](../../../src/apple/Maple.xcodeproj/project.pbxproj), PBXFrameworksBuildPhase at [`pbxproj:48-54`](../../../src/apple/Maple.xcodeproj/project.pbxproj), PBXResourcesBuildPhase at [`pbxproj:190-196`](../../../src/apple/Maple.xcodeproj/project.pbxproj), PBXSourcesBuildPhase at [`pbxproj:248-254`](../../../src/apple/Maple.xcodeproj/project.pbxproj), `XCBuildConfiguration` Debug+Release at [`pbxproj:535-578`](../../../src/apple/Maple.xcodeproj/project.pbxproj), `XCConfigurationList` at [`pbxproj:591-599`](../../../src/apple/Maple.xcodeproj/project.pbxproj), PBXTargetDependency at [`pbxproj:258-262`](../../../src/apple/Maple.xcodeproj/project.pbxproj), PBXContainerItemProxy at [`pbxproj:15-21`](../../../src/apple/Maple.xcodeproj/project.pbxproj)) but with: - `productType = "com.apple.product-type.bundle.ui-testing"` - `PRODUCT_BUNDLE_IDENTIFIER = app.justmaple.aperture.UITests` - `TEST_TARGET_NAME = Maple` (instead of `BUNDLE_LOADER` + `TEST_HOST`) - new `PBXFileSystemSynchronizedRootGroup` for `MapleUITests/` (mirroring [`pbxproj:30-36`](../../../src/apple/Maple.xcodeproj/project.pbxproj)) - product reference `MapleUITests.xctest` - all new IDs in the `A1F0XXXX00000000000000A1` namespace, picking unused values (e.g. `A1F0006000000000000000A1` onward).
      Add the target to `PBXProject.targets` ([`pbxproj:175-178`](../../../src/apple/Maple.xcodeproj/project.pbxproj)) and the Products group ([`pbxproj:83-91`](../../../src/apple/Maple.xcodeproj/project.pbxproj)).

- [ ] **Step 1.4: Re-run `xcodebuild -project … -list`.** Verify: output now lists three targets (`Maple`, `MapleTests`, `MapleUITests`).

- [ ] **Step 1.5: Build the new target with no sources.**
      `bash
    xcodebuild -project src/apple/Maple.xcodeproj \
               -scheme Maple \
               -destination 'platform=macOS' \
               -only-testing:MapleUITests \
               build-for-testing
    `
      Verify: build succeeds (or fails only on "no test classes found", which is fine for an empty target).

- [ ] **Step 1.6: Add `MapleUITests` to the Maple scheme's test action.** Edit `Maple.xcodeproj/xcshareddata/xcschemes/Maple.xcscheme` to add a `<TestableReference>` for `MapleUITests.xctest`. Verify by running `xcodebuild -project … -scheme Maple test-without-building -only-testing:MapleUITests` — expect "no tests to run" rather than "scheme has no test action".

- [ ] **Step 1.7: Commit. Message:** `test(uitests): add MapleUITests target scaffold (no sources yet)`.

> **Fallback for Step 1.3 if the hand-edit fails to parse:**
>
> 1. Restore the backup: `cp /tmp/maple-pbxproj.backup src/apple/Maple.xcodeproj/project.pbxproj`.
> 2. Open the project in Xcode (`open src/apple/Maple.xcodeproj`).
> 3. File → New → Target → macOS → UI Testing Bundle. Name `MapleUITests`, target `Maple`.
> 4. Close Xcode, run `git diff src/apple/Maple.xcodeproj/project.pbxproj` to capture the exact additions.
> 5. Cherry-pick the additions into the manual edit to fix mistakes; or, if the Xcode-generated diff is acceptable, commit it directly.
> 6. The Xcode-generated bundle ID will be wrong (`com.lawrence.MapleUITests` or similar — depends on `DEVELOPMENT_TEAM = QREP66JW5U` at [`pbxproj:404,474`](../../../src/apple/Maple.xcodeproj/project.pbxproj)); set `PRODUCT_BUNDLE_IDENTIFIER = app.justmaple.aperture.UITests` in build settings and re-confirm with `xcodebuild -list`.

## Task 2: Add accessibility identifiers to canvas, thumbnails, sliders

- [ ] **Step 2.1: Add `accessibilityIdentifier("canvas-render-ready")` to the canvas in `FullImageView.swift`.** Apply to the `CIImageView` at [`FullImageView.swift:146-150`](../../../src/apple/Maple/Views/FullImageView.swift), conditional on `!session.isRendering && session.renderedPreview != nil`. Approach: wrap the `CIImageView` in a `Group` and apply `.accessibilityIdentifier(...)` only when both predicates are true (otherwise no identifier — the matcher won't find it until refine completes).

- [ ] **Step 2.2: Add `accessibilityIdentifier("thumb-\(asset.displayName)")` to `ThumbnailCell` in `BrowseGrid.swift`.** Apply on the outer `VStack` at [`BrowseGrid.swift:277-313`](../../../src/apple/Maple/Views/BrowseGrid.swift). Verify locally by enabling Accessibility Inspector on a running build.

- [ ] **Step 2.3: Add `accessibilityIdentifier("slider-\(label.lowercased())")` to `AdjustSlider`.** Find `AdjustSlider`'s definition in `DetailPanel.swift` (referenced by call-sites at [`DetailPanel.swift:216-257,289-312`](../../../src/apple/Maple/Views/DetailPanel.swift)); the helper view that wraps the SwiftUI `Slider` is the right place to add the modifier. Strip whitespace and special chars (`label.lowercased().replacingOccurrences(of: " ", with: "-")`) so a "NR Lum" label becomes `slider-nr-lum`.

- [ ] **Step 2.4: Add `accessibilityIdentifier("browse-grid")` to the `LazyVGrid` in `BrowseGrid.swift`.** Sentinel for the harness to know browse mode is active.

- [ ] **Step 2.5: Run unit tests to confirm no regression.**
      `bash
    cd src/apple/Packages/MapleCore && swift test
    `
      Verify: all existing tests pass (identifiers are SwiftUI-only and shouldn't affect MapleCore unit tests).

- [ ] **Step 2.6: Build the app to confirm SwiftUI compiles.**
      `bash
    xcodebuild -project src/apple/Maple.xcodeproj \
               -scheme Maple \
               -destination 'platform=macOS' \
               build
    `
      Verify: clean build, no warnings about identifier-on-non-element.

- [ ] **Step 2.7: Commit. Message:** `feat(apple): add accessibility identifiers for UITest harness`.

## Task 3: Implement `MapleUITests/Helpers/MapleAppDriver.swift`

- [ ] **Step 3.1: Add the `MAPLE_UITEST_FIXTURE` hook in `MapleApp.swift`.** Inside `init()` ([`MapleApp.swift:13-26`](../../../src/apple/Maple/MapleApp.swift)), add a `#if DEBUG` block that reads `ProcessInfo.processInfo.environment["MAPLE_UITEST_FIXTURE"]`, validates the path exists, and stashes it on a global / launch-time singleton that `AppShell` consumes on `.task`. The shell calls `browseVM.loadSingleAsset(url:)` (a new helper on `BrowseViewModel`) to seed the library with one asset, then auto-navigates into Full-image mode. NB: this is the only `src/` change in this task that's not pure test code; flag it explicitly in the commit message.

- [ ] **Step 3.2: Write `MapleUITests/Helpers/MapleAppDriver.swift`.** Fluent API:
      `swift
    let app = MapleAppDriver.launch(fixture: "test_0017.dng")
    app.waitForBrowseGrid()
    app.openAsset(named: "test_0017")
    app.waitForCanvasReady(timeout: 30)
    let png = app.screenshotCanvas()
    `
      `launch(fixture:)` resolves the fixture path against `MAPLE_UITEST_FIXTURE_ROOT` (env var, defaults to `<repo>/test-fixtures/raws`), calls `XCTSkip` if the file's missing, sets `app.launchEnvironment["MAPLE_UITEST_FIXTURE"]`, and runs `app.launch()`.

- [ ] **Step 3.3: Write the empty test stub at `MapleUITests/MapleUITests.swift`.** Single `XCTestCase` class, single empty `testCanvasMatchesGolden` method that just calls `MapleAppDriver.launch(...)` and asserts the canvas appears.

- [ ] **Step 3.4: Run the test to confirm the launch flow works.**
      `bash
    xcodebuild test -project src/apple/Maple.xcodeproj \
                    -scheme Maple \
                    -destination 'platform=macOS' \
                    -only-testing:MapleUITests/MapleUITests/testCanvasMatchesGolden \
                    MAPLE_UITEST_FIXTURE_ROOT="$PWD/test-fixtures/raws"
    `
      Verify: test runs to completion (with the `XCTSkip` if fixtures are absent, or a clean pass if `test_0017.dng` is present and the canvas appears).

- [ ] **Step 3.5: Commit. Message:** `feat(uitests): add MapleAppDriver with fixture-launch flow`.

## Task 4: Implement `MapleUITests/Helpers/CIEDE2000.swift`

- [ ] **Step 4.1: Port the math.** Translate `compare_images.py`'s `colour.delta_E(method="CIE 2000")` to Swift. Reference math: Sharma, Wu, Dalal — "The CIEDE2000 Color-Difference Formula" (2005). Implement as `func ciede2000(srgb1: Data, srgb2: Data, width: Int, height: Int) -> (mean: Double, p95: Double, max: Double, biasR: Double, biasG: Double, biasB: Double)`. sRGB→XYZ uses Bradford-adapted D65; XYZ→Lab uses standard CIE Lab math.

- [ ] **Step 4.2: Add a unit test that cross-validates against `compare_images.py`.** Pick two static PNGs to commit at `test-fixtures/golden-screenshots/.calibration/{a,b}.png` (small, e.g. 64×64 of distinguishable but close colors). The test: 1. Reads both PNGs. 2. Runs the Swift port. 3. Shells out to `python3 src/scripts/compare_images.py a.png b.png` and parses the JSON. 4. Asserts `abs(swift.mean - python.mean) < 1e-3`, same for p95/max/bias.

- [ ] **Step 4.3: Run the unit test.**
      `bash
    xcodebuild test -project src/apple/Maple.xcodeproj \
                    -scheme Maple \
                    -destination 'platform=macOS' \
                    -only-testing:MapleUITests/CIEDE2000Tests
    `
      Verify: test passes.

- [ ] **Step 4.4: Commit. Message:** `feat(uitests): add Swift CIEDE2000 port + cross-validation`.

## Task 5: First end-to-end test with golden comparison

- [ ] **Step 5.1: Implement `MapleUITests/Helpers/GoldenStore.swift`.** Resolves goldens against `MAPLE_UITEST_GOLDENS_ROOT` (defaults to `<repo>/test-fixtures/golden-screenshots`). API: `loadGolden(name:) -> Data?` (returns nil on first run); `writeGolden(name:_:)` writes PNG bytes; `compareOrRecord(name:candidate:budget:) throws` does the full diff-or-record dance with `XCTFail("baseline written…")` on first run.

- [ ] **Step 5.2: Wire `testCanvasMatchesGolden` end-to-end.** The full test:
      `swift
    let app = MapleAppDriver.launch(fixture: "test_0017.dng")
    app.waitForCanvasReady(timeout: 30)
    let png = app.screenshotCanvas()
    try GoldenStore.compareOrRecord(
        name: "test_0017-default",
        candidate: png,
        budget: .init(mean: 5, p95: 10, max: 30, bias: 0.05))
    `

- [ ] **Step 5.3: First run — record the baseline.**
      `bash
    xcodebuild test -project src/apple/Maple.xcodeproj \
                    -scheme Maple \
                    -destination 'platform=macOS' \
                    -only-testing:MapleUITests/MapleUITests/testCanvasMatchesGolden \
                    MAPLE_UITEST_FIXTURE_ROOT="$PWD/test-fixtures/raws"
    `
      Verify: test FAILS with the "baseline written, please verify" message; `test-fixtures/golden-screenshots/test_0017-default.png` is on disk and visually correct.

- [ ] **Step 5.4: Calibrate the budget.** Re-run the test 3 more times; each should now PASS at the default budget (mean 5 / p95 10 / max 30). If any of the three exceeds the budget, raise the budget to the 95th-percentile drift + 20% headroom and document the calibration in a comment on `compareOrRecord`.

- [ ] **Step 5.5: Commit the golden + final test.** Message: `test(uitests): add canvas-screenshot regression test on test_0017`.

## Task 6: Document the workflow

- [ ] **Step 6.1: Locate the test-conventions doc.** Run `ls docs/ | grep -i test` and `grep -rn "Build & test" docs/`. The project uses `CLAUDE.md` § "Build & test — Apple" as the test-runner overview but doesn't have a dedicated `docs/testing.md`. Either (a) extend the existing `CLAUDE.md` § with a UITest subsection, or (b) create `docs/testing.md` and link to it from `CLAUDE.md`. Pick (a) for v1 to keep the docs surface small.

- [ ] **Step 6.2: Add a "UITest visual harness" subsection to `CLAUDE.md` § "Build & test — Apple".** Cover: the `xcodebuild test` invocation from § 9 of the brief, the `MAPLE_UITEST_FIXTURE_ROOT` env var, the golden re-record workflow (delete the file + re-run), and a pointer to this plan. Cite the brief and plan paths.

- [ ] **Step 6.3: Commit. Message:** `docs: document UITest visual-regression harness workflow`.

## Task 7 (follow-up milestone): slider-state matrix

> Not part of the v1 cut. Tracks the post-v1 expansion.

- [ ] **Step 7.1: Add `test_0000.dng` and `test_0007.dng` fixtures to the test parameterization.** Each gets its own default-state golden and `XCTestCase` method.

- [ ] **Step 7.2: Implement `app.setSliderValue(name:to:)` on `MapleAppDriver`.** Wraps `app.sliders["slider-\(name)"].adjust(toNormalizedSliderPosition:)`.

- [ ] **Step 7.3: Add per-slider state tests.** exposure {-2, 0, +2}, contrast {0, +50}, sharpening {0, +100}, nr-luminance {0, +50}, dehaze {0, +50}. ~12 states per fixture × 3 fixtures = ~36 goldens. Naming: `<fixture>-<slider>-<value>.png`.

- [ ] **Step 7.4: Commit per-fixture or per-slider as logical milestones.**
