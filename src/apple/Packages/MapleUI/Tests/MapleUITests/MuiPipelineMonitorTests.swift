import XCTest
@testable import MapleUI

final class MuiPipelineMonitorTests: XCTestCase {
    func testOverallProgressAggregatesAcrossStages() {
        let stages = [
            MuiPipelineStage(id: "exif", name: "EXIF", status: .done, processed: 100, total: 100),
            MuiPipelineStage(id: "thumb", name: "Thumbnails", status: .running, processed: 50, total: 100),
        ]
        // (100 + 50) / (100 + 100) = 75%
        XCTAssertEqual(MuiPipelineMonitor.overallProgress(stages), 75)
    }

    func testOverallProgressIsZeroForNoStages() {
        XCTAssertEqual(MuiPipelineMonitor.overallProgress([]), 0)
    }

    func testOverallProgressIsZeroWhenTotalsAreZero() {
        let stages = [MuiPipelineStage(id: "exif", name: "EXIF", status: .paused, processed: 0, total: 0)]
        XCTAssertEqual(MuiPipelineMonitor.overallProgress(stages), 0)
    }

    func testStageProgressComputesPerStagePercentage() {
        let stage = MuiPipelineStage(id: "exif", name: "EXIF", status: .running, processed: 25, total: 200)
        XCTAssertEqual(MuiPipelineMonitor.stageProgress(stage), 13)
    }

    func testCanToggleOnlyForRunningOrPaused() {
        XCTAssertTrue(MuiPipelineMonitor.canToggle(MuiPipelineStage(id: "1", name: "A", status: .running, processed: 0, total: 1)))
        XCTAssertTrue(MuiPipelineMonitor.canToggle(MuiPipelineStage(id: "1", name: "A", status: .paused, processed: 0, total: 1)))
        XCTAssertFalse(MuiPipelineMonitor.canToggle(MuiPipelineStage(id: "1", name: "A", status: .done, processed: 0, total: 1)))
        XCTAssertFalse(MuiPipelineMonitor.canToggle(MuiPipelineStage(id: "1", name: "A", status: .error, processed: 0, total: 1)))
    }

    func testBadgeVariantIsSignalForRunningAndError() {
        XCTAssertEqual(MuiPipelineMonitor.badgeVariant(.running), .signal)
        XCTAssertEqual(MuiPipelineMonitor.badgeVariant(.error), .signal)
        XCTAssertEqual(MuiPipelineMonitor.badgeVariant(.paused), .count)
        XCTAssertEqual(MuiPipelineMonitor.badgeVariant(.done), .count)
    }
}
