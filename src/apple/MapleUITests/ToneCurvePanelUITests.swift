// ToneCurvePanelUITests.swift — visual-regression gate for the Tone Curve
// widget (#367).
//
// Sibling of `MapleUITests.testCanvasMatchesGolden`, and deliberately the
// other half of that pair: the canvas golden watches what the PIPELINE
// produces, this one watches what the WIDGET looks like. Same harness, same
// CIEDE2000 metric, same "first run records the baseline and fails with a
// 'baseline written' message" contract — re-record by deleting
// `MapleUITests/Goldens/tone-curve-plot-default.png` and re-running.
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

    func testToneCurvePlotMatchesGolden() throws {
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
            name: "tone-curve-plot-default",
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
