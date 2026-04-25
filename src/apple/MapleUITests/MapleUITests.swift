// MapleUITests.swift — visual-regression harness entry point.
//
// Per Task 5 of docs/superpowers/plans/2026-04-25-xcuitest-visual-harness.md
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
        try GoldenStore.compareOrRecord(
            name: "test_0017-default",
            candidate: png,
            budget: GoldenBudget(mean: 5, p95: 10, max: 30, bias: 0.05)
        )
    }
}
