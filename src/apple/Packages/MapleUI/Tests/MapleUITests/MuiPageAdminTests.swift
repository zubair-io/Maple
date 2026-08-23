import XCTest
@testable import MapleUI

final class MuiPageAdminTests: XCTestCase {
    private let stages: [MuiPipelineStage] = [
        MuiPipelineStage(id: "exif", name: "EXIF", status: .done, processed: 100, total: 100),
        MuiPipelineStage(id: "thumb", name: "Thumbnails", status: .running, processed: 50, total: 100),
        MuiPipelineStage(id: "geocode", name: "Geocode", status: .error, processed: 0, total: 100),
    ]

    func testTogglingPauseFlipsARunningStageToPaused() {
        let next = MuiPageAdmin.togglingPause(stages, id: "thumb")
        XCTAssertEqual(next.first { $0.id == "thumb" }?.status, .paused)
    }

    func testTogglingPauseFlipsAPausedStageBackToRunning() {
        let paused = MuiPageAdmin.togglingPause(stages, id: "thumb")
        let next = MuiPageAdmin.togglingPause(paused, id: "thumb")
        XCTAssertEqual(next.first { $0.id == "thumb" }?.status, .running)
    }

    func testTogglingPauseIsANoOpOnADoneStage() {
        let next = MuiPageAdmin.togglingPause(stages, id: "exif")
        XCTAssertEqual(next.first { $0.id == "exif" }?.status, .done)
    }

    func testTogglingPauseIsANoOpOnAnErroredStage() {
        let next = MuiPageAdmin.togglingPause(stages, id: "geocode")
        XCTAssertEqual(next.first { $0.id == "geocode" }?.status, .error)
    }

    func testRetryingResumesAnErroredStageFromItsProcessedCount() {
        let next = MuiPageAdmin.retrying(stages, id: "geocode")
        let stage = next.first { $0.id == "geocode" }
        XCTAssertEqual(stage?.status, .running)
        XCTAssertEqual(stage?.processed, 0)
    }

    func testRetryingIsANoOpOnAStageThatIsNotErrored() {
        let next = MuiPageAdmin.retrying(stages, id: "thumb")
        XCTAssertEqual(next.first { $0.id == "thumb" }?.status, .running)
    }
}
