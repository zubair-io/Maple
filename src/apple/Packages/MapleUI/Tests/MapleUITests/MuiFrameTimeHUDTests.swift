import XCTest
@testable import MapleUI

final class MuiFrameTimeHUDTests: XCTestCase {
    func testStatusGoodAtOrUnderBudget() {
        XCTAssertEqual(MuiFrameTimeHUD.status(frameMs: 16, budgetMs: 16, hardLimitMs: 50), .good)
        XCTAssertEqual(MuiFrameTimeHUD.status(frameMs: 10, budgetMs: 16, hardLimitMs: 50), .good)
    }

    func testStatusWarnBetweenBudgetAndHardLimit() {
        XCTAssertEqual(MuiFrameTimeHUD.status(frameMs: 30, budgetMs: 16, hardLimitMs: 50), .warn)
    }

    func testStatusBadOverHardLimit() {
        XCTAssertEqual(MuiFrameTimeHUD.status(frameMs: 51, budgetMs: 16, hardLimitMs: 50), .bad)
    }

    func testDisplayFpsPrefersExplicitOverride() {
        XCTAssertEqual(MuiFrameTimeHUD.displayFps(frameMs: 16, fps: 90), 90)
    }

    func testDisplayFpsDerivesFromFrameTime() {
        XCTAssertEqual(MuiFrameTimeHUD.displayFps(frameMs: 16.6666, fps: nil), 60)
    }

    func testDisplayFpsZeroFrameTimeIsZero() {
        XCTAssertEqual(MuiFrameTimeHUD.displayFps(frameMs: 0, fps: nil), 0)
    }
}
