import XCTest
@testable import MapleUI

final class MuiSplitLayoutMathTests: XCTestCase {
    // MARK: clamp

    func testClampWithinRangeIsUnchanged() {
        XCTAssertEqual(MuiSplitLayoutMath.clamp(300, min: 200, max: 400), 300)
    }

    func testClampBelowMinSnapsToMin() {
        XCTAssertEqual(MuiSplitLayoutMath.clamp(50, min: 200, max: 400), 200)
    }

    func testClampAboveMaxSnapsToMax() {
        XCTAssertEqual(MuiSplitLayoutMath.clamp(9999, min: 200, max: 400), 400)
    }

    func testClampAtExactBoundsIsUnchanged() {
        XCTAssertEqual(MuiSplitLayoutMath.clamp(200, min: 200, max: 400), 200)
        XCTAssertEqual(MuiSplitLayoutMath.clamp(400, min: 200, max: 400), 400)
    }

    // MARK: sidebarCollapsed

    func testSidebarCollapsedBelowThreshold() {
        XCTAssertTrue(MuiSplitLayoutMath.sidebarCollapsed(hostWidth: 500, collapseEnabled: true))
    }

    func testSidebarNotCollapsedAtOrAboveThreshold() {
        XCTAssertFalse(MuiSplitLayoutMath.sidebarCollapsed(hostWidth: MuiSplitLayoutMath.sidebarCollapsePx, collapseEnabled: true))
        XCTAssertFalse(MuiSplitLayoutMath.sidebarCollapsed(hostWidth: 1000, collapseEnabled: true))
    }

    func testSidebarNeverCollapsesWhenCollapseDisabled() {
        XCTAssertFalse(MuiSplitLayoutMath.sidebarCollapsed(hostWidth: 100, collapseEnabled: false))
    }

    // MARK: detailCollapsed

    func testDetailCollapsedWhenShowDetailFalseRegardlessOfWidth() {
        XCTAssertTrue(MuiSplitLayoutMath.detailCollapsed(showDetail: false, hostWidth: 2000, collapseEnabled: true))
    }

    func testDetailCollapsedBelowThresholdWhenShown() {
        XCTAssertTrue(MuiSplitLayoutMath.detailCollapsed(showDetail: true, hostWidth: 800, collapseEnabled: true))
    }

    func testDetailNotCollapsedAtOrAboveThresholdWhenShown() {
        XCTAssertFalse(MuiSplitLayoutMath.detailCollapsed(showDetail: true, hostWidth: MuiSplitLayoutMath.detailCollapsePx, collapseEnabled: true))
        XCTAssertFalse(MuiSplitLayoutMath.detailCollapsed(showDetail: true, hostWidth: 1200, collapseEnabled: true))
    }

    func testDetailNeverCollapsesForWidthWhenCollapseDisabled() {
        XCTAssertFalse(MuiSplitLayoutMath.detailCollapsed(showDetail: true, hostWidth: 100, collapseEnabled: false))
    }

    func testDetailStillCollapsesWhenNotShownEvenWithCollapseDisabled() {
        // showDetail=false always wins — collapseEnabled only governs the
        // width-driven collapse, not the caller's own "nothing to show" case.
        XCTAssertTrue(MuiSplitLayoutMath.detailCollapsed(showDetail: false, hostWidth: 100, collapseEnabled: false))
    }

    // MARK: collapse ordering (Detail collapses before Sidebar)

    func testDetailCollapsesBeforeSidebarAtIntermediateWidth() {
        let intermediateWidth = (MuiSplitLayoutMath.sidebarCollapsePx + MuiSplitLayoutMath.detailCollapsePx) / 2
        XCTAssertTrue(MuiSplitLayoutMath.detailCollapsed(showDetail: true, hostWidth: intermediateWidth, collapseEnabled: true))
        XCTAssertFalse(MuiSplitLayoutMath.sidebarCollapsed(hostWidth: intermediateWidth, collapseEnabled: true))
    }
}
