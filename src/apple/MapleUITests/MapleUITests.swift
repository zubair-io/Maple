// MapleUITests.swift — visual-regression harness entry point.
//
// Per Task 5 of .archived-plans/plans/2026-04-25-xcuitest-visual-harness.md
// this single test launches Maple with a fixture, waits for the refine
// pass, screenshots the canvas, and compares against a committed
// golden via the Swift CIEDE2000 port at Helpers/CIEDE2000.swift.
//
// First run records the baseline + fails with a "baseline written"
// message. Subsequent runs diff. Re-record by deleting the PNG.

import XCTest

final class MapleUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// Visual-regression gate. Launches Maple with `test_0017.dng`,
    /// waits for the refine pass to publish a preview, screenshots the
    /// canvas, and compares against the committed golden via the Swift
    /// CIEDE2000 port. First run writes the baseline + fails with a
    /// "baseline written" message — re-record by deleting
    /// `MapleUITests/Goldens/test_0017-default.png` and re-running.
    ///
    /// Budgets:
    ///   - mean ΔE ≤ 5
    ///   - p95 ΔE ≤ 10
    ///   - max ΔE ≤ 30
    ///   - per-channel bias ≤ 0.05 (5% of [0,1])
    /// Calibrated empirically per the brief (§ 7) on 3 runs against a
    /// fresh golden — adjust upward only on documented run-to-run
    /// drift, never to paper over a real regression.
    func testCanvasMatchesGolden() throws {
        let driver = try MapleAppDriver.launch(fixture: "test_0017.dng")
        driver.waitForCanvasReady(timeout: 30)
        let png = driver.screenshotCanvas()
        if let outcome = MapleAppDriver.lastSpikeBOutcome {
            print("[spike-b] canvas screenshot path: \(outcome)")
        }
        try GoldenStore.compareOrRecord(
            name: "test_0017-default",
            candidate: png,
            budget: GoldenBudget(mean: 5, p95: 10, max: 30, bias: 0.05)
        )
    }

    /// Spike B (per the harness plan): record whether
    /// `XCUIElement.screenshot()` returns a tightly-cropped image or a
    /// full-window capture on macOS. The harness's `screenshotCanvas()`
    /// already self-corrects via a frame check, but recording the
    /// observed outcome here lets us tighten the heuristic later if the
    /// chosen path differs from what the brief assumed.
    ///
    /// This test is fast (no fixture, no decode wait) — pairs with
    /// `testCanvasMatchesGolden` so a single auth-prompt approval covers
    /// both runs.
    func testSpikeBElementScreenshotCropping() throws {
        // Launch with no fixture so we don't depend on the decode path
        // for this test. AppShell's empty browse view is enough to
        // exercise the toolbar's Search button identifier.
        let app = XCUIApplication()
        app.launch()
        let search = app.buttons["Search"]
        let appeared = search.waitForExistence(timeout: 10)
        XCTAssertTrue(appeared, "Search button (toolbar) did not appear within 10s — accessibility wiring regressed?")
        let elementShot = search.screenshot().image
        let screenShot = XCUIScreen.main.screenshot().image
        let elementSize = elementShot.size
        let screenSize = screenShot.size
        let frame = search.frame
        // Tight crop heuristic (mirror screenshotCanvas):
        let tight =
            elementSize.width  <= frame.width  * 1.1 &&
            elementSize.height <= frame.height * 1.1
        let verdict = tight
            ? "TIGHT  (\(Int(elementSize.width))×\(Int(elementSize.height)) within \(Int(frame.width))×\(Int(frame.height)) * 1.1)"
            : "WINDOW (\(Int(elementSize.width))×\(Int(elementSize.height)) >> \(Int(frame.width))×\(Int(frame.height)))"
        print("[spike-b] verdict: \(verdict)")
        print("[spike-b] screen: \(Int(screenSize.width))×\(Int(screenSize.height))")
        // Always pass — this is a recording test, not a gate.
    }
}
