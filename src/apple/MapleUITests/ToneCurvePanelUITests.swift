// ToneCurvePanelUITests.swift — visual-regression gate for the Tone Curve
// widget (#367).
//
// Sibling of `MapleUITests.testCanvasMatchesGolden`, and deliberately the
// other half of that pair: the canvas golden watches what the PIPELINE
// produces, this one watches what the WIDGET looks like. Same harness, same
// CIEDE2000 metric.
//
// ## Why no golden PNG is committed yet
//
// `Goldens/tone-curve-plot-default.png` is deliberately ABSENT. macOS element
// screenshots composite from the SCREEN rather than from the app's own layer
// tree, so a capture taken while any other window overlaps the plot bakes that
// window into the baseline. The recording attempted for #367 was contaminated
// exactly that way — a second Maple window's Light panel occluded the left
// edge of the plot — and a contaminated golden is worse than none: it locks
// the gate to a wrong image, and every later run then "passes" against it.
//
// So the pixel gate SKIPS while the baseline is missing, matching the
// skip-pass convention the rest of this harness uses for absent fixtures (see
// `MapleAppDriver.launch` and `src/scripts/test_color_pipeline.sh`). It does
// NOT fall into `GoldenStore.compareOrRecord`'s first-run "baseline written"
// FAILURE path, which is what the reviewer flagged: with fixtures present and
// no PNG on disk, that path made every run fail by construction.
// `testToneCurvePanelExposesItsControls` below is unconditional and carries
// the real value in the meantime — it asserts the panel renders, is reachable
// and is labelled, which is the regression most likely to actually happen.
//
// To record one: on a machine with no other UI-test session holding the
// screen, and with no other window over the panel, delete the `XCTSkipIf`
// guard's premise by running this test once — `compareOrRecord` writes the PNG
// into the runner's container and fails with "baseline written". Open it,
// confirm only the plot is in frame, then copy it to
// `src/apple/MapleUITests/Goldens/` and commit. Re-record later by deleting
// the PNG and repeating.
//
// The panel is reached by arming the Curve tool through the dock button
// (`editor-dock-tool-toneCurve`), which is how a user reaches it in the
// default `.compact` control variant: Tone Curve has no primary field, so
// `LivingSliderGrid` filters it out of the Light group's slider stack and the
// dock is its route in. On macOS-regular that variant mounts
// `FlyoutSliderPanel`, which swaps in `ToneCurveSection` while the tool is
// armed.
//
// The golden is the PLOT, not the whole section. Two reasons: it is the part
// this ticket actually draws (the sliders are the existing `LivingSlider`,
// already covered elsewhere), and it is the only sub-tree whose accessibility
// identifier survives — an `accessibilityIdentifier` on a plain SwiftUI
// container propagates down and replaces its descendants' ids, so the
// section's own id is overwritten by the enclosing panel's
// `editor-flyout-panel`. Cropping to the plot also matches the existing
// goldens' "canvas-only, no chrome" philosophy, which keeps the committed PNG
// small and immune to unrelated panel-layout churn.

import XCTest

// Same `os(macOS)` gate as `MapleUITests`: `MapleAppDriver` drives AppKit /
// XCUIApplication, so the target still compiles for the iOS Simulator (which
// `PanoOrtSelftestUITests` needs).
#if os(macOS)
final class ToneCurvePanelUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// Arm the Curve tool and return the running app, or skip when the
    /// fixture is absent (mirrors every other harness in this target).
    private func launchWithCurveArmed() throws -> XCUIApplication {
        let driver = try MapleAppDriver.launch(fixture: "test_0017.dng")
        driver.waitForCanvasReady(timeout: 30)

        let app = XCUIApplication()
        let curveButton = app.buttons["editor-dock-tool-toneCurve"]
        XCTAssertTrue(
            curveButton.waitForExistence(timeout: 10),
            "Curve dock button missing — the tone-curve tool lost its only route "
                + "into the default control variant."
        )
        curveButton.click()
        return app
    }

    /// Name of the baseline this gate diffs against. Not committed yet — see
    /// the file header for why, and for how to record one.
    private static let goldenName = "tone-curve-plot-default"

    func testToneCurvePlotMatchesGolden() throws {
        // Skipped BEFORE launching: with no baseline on disk there is nothing
        // to diff against, and letting `compareOrRecord` take its first-run
        // path here would both fail the run and write whatever happened to be
        // on screen. See the file header.
        try XCTSkipIf(
            GoldenStore.loadGolden(name: Self.goldenName) == nil,
            "no committed golden for \(Self.goldenName) — see this file's header "
                + "for why it is absent and how to record one"
        )

        let app = try launchWithCurveArmed()

        let plot = app.groups["editor-tone-curve-plot"]
        XCTAssertTrue(
            plot.waitForExistence(timeout: 10),
            "Tone Curve plot did not appear after arming the Curve tool."
        )

        // The plot's histogram backdrop loads behind a 350ms debounce; give it
        // room to settle so the golden is of the settled widget, not a
        // half-painted one.
        Thread.sleep(forTimeInterval: 2.0)

        try GoldenStore.compareOrRecord(
            name: Self.goldenName,
            candidate: plot.screenshot().pngRepresentation,
            budget: GoldenBudget(mean: 5, p95: 10, max: 40, bias: 0.05)
        )
    }

    /// Cheap structural companion to the pixel gate: the controls the widget
    /// promises are present and labelled. A golden catches a visual
    /// regression; this catches an accessibility one, which a screenshot
    /// cannot see at all.
    func testToneCurvePanelExposesItsControls() throws {
        let app = try launchWithCurveArmed()
        XCTAssertTrue(app.groups["editor-tone-curve-plot"].waitForExistence(timeout: 10))

        for channel in ["luma", "r", "g", "b"] {
            XCTAssertTrue(
                app.buttons["editor-tone-curve-channel-\(channel)"].exists,
                "channel chip \(channel) missing"
            )
        }
        for region in ["highlights", "lights", "darks", "shadows"] {
            XCTAssertTrue(
                app.otherElements["editor-tone-curve-\(region)"].exists,
                "region slider \(region) missing"
            )
        }
        // An unedited curve materialises its two corner anchors, and both must
        // be reachable as labelled elements rather than pixels in a canvas.
        XCTAssertTrue(app.otherElements["editor-tone-curve-knot-0"].exists)
        XCTAssertTrue(app.otherElements["editor-tone-curve-knot-1"].exists)
        // Reset is disabled on an identity curve — it has nothing to undo.
        XCTAssertFalse(app.buttons["editor-tone-curve-reset"].isEnabled)
    }
}
#endif // os(macOS)
