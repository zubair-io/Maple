import XCTest
@testable import MapleUI

final class MuiProgressStepTests: XCTestCase {
    func testPendingStepShowsZeroProgress() {
        XCTAssertEqual(MuiProgressStep.progressValue(status: .pending), 0)
    }

    func testActiveStepIsIndeterminate() {
        XCTAssertNil(MuiProgressStep.progressValue(status: .active))
    }

    func testDoneStepIsFullyComplete() {
        XCTAssertEqual(MuiProgressStep.progressValue(status: .done), 100)
    }

    func testTheFullPendingToActiveToDoneTransitionSequence() {
        let sequence: [MuiProgressStepStatus] = [.pending, .active, .done]
        let values = sequence.map { MuiProgressStep.progressValue(status: $0) }
        XCTAssertEqual(values, [0, nil, 100])
    }
}
