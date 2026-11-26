// LaunchTimelineTests.swift — launch milestones record once, relative to
// process start (#6017).

import XCTest
@testable import MapleCore

final class LaunchTimelineTests: XCTestCase {

  func testMilestoneRecordsOnlyItsFirstArrival() {
    // Date is a Double from 2001; at 1970 its step is ~1e-7 s, coarser than the 1e-9 tolerance.
    let start = Date(timeIntervalSinceReferenceDate: 0)
    let timeline = LaunchTimeline(processStart: start)

    let first = timeline.mark(.gridPublished, at: start.addingTimeInterval(0.4))
    let second = timeline.mark(.gridPublished, at: start.addingTimeInterval(2))

    XCTAssertEqual(first ?? -1, 0.4, accuracy: 1e-9)
    XCTAssertNil(second)
    XCTAssertEqual(timeline.elapsed(for: .gridPublished) ?? -1, 0.4, accuracy: 1e-9)
    XCTAssertNil(timeline.elapsed(for: .firstThumbnail))
  }

  func testProcessStartPrecedesNow() {
    let start = LaunchTimeline.processStartDate()
    XCTAssertLessThanOrEqual(start, Date())
    XCTAssertGreaterThan(start, Date().addingTimeInterval(-24 * 60 * 60 * 365))
  }
}
