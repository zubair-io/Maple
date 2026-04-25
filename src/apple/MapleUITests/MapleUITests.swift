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

    /// Stubbed in Task 3.3. Wired end-to-end in Task 5.5 once the
    /// `GoldenStore` and `CIEDE2000` helpers land. Today this just
    /// confirms the launch flow works: env var → AppShell.task →
    /// `loadSingleAsset` → `mode = .fullImage` → canvas appears.
    func testCanvasMatchesGolden() throws {
        let driver = try MapleAppDriver.launch(fixture: "test_0017.dng")
        driver.waitForCanvasReady(timeout: 30)
        XCTAssertTrue(driver.canvasElement().exists,
                      "canvas-render-ready element not present after refine")
    }
}
