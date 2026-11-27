import CoreGraphics
import XCTest

@testable import MapleCore

final class CellFrameIndexTests: XCTestCase {
  private func shownCell(_ frame: CGRect, _ id: String, in index: inout CellFrameIndex<String>) {
    index.appeared(id)
    index.record(frame, for: id)
  }

  private func twoCellIndex() -> CellFrameIndex<String> {
    var index = CellFrameIndex<String>()
    shownCell(CGRect(x: 0, y: 0, width: 100, height: 100), "a", in: &index)
    shownCell(CGRect(x: 104, y: 0, width: 100, height: 100), "b", in: &index)
    return index
  }

  func testPointInsideACellReturnsThatCell() {
    let index = twoCellIndex()
    XCTAssertEqual(index.cell(at: CGPoint(x: 50, y: 50)), "a")
    XCTAssertEqual(index.cell(at: CGPoint(x: 150, y: 99)), "b")
  }

  func testPointInTheGapBetweenCellsReturnsNothing() {
    XCTAssertNil(twoCellIndex().cell(at: CGPoint(x: 102, y: 50)))
  }

  func testPointOutsideEveryCellReturnsNothing() {
    XCTAssertNil(twoCellIndex().cell(at: CGPoint(x: 50, y: 150)))
    XCTAssertNil(CellFrameIndex<String>().cell(at: .zero))
  }

  func testYAxisPointsDownFromTheTopLeftOrigin() {
    var index = CellFrameIndex<String>()
    shownCell(CGRect(x: 0, y: 0, width: 100, height: 100), "top", in: &index)
    shownCell(CGRect(x: 0, y: 104, width: 100, height: 100), "below", in: &index)
    XCTAssertEqual(index.cell(at: CGPoint(x: 10, y: 10)), "top")
    XCTAssertEqual(index.cell(at: CGPoint(x: 10, y: 110)), "below")
  }

  func testCellOffScreenNoLongerMatches() {
    var index = twoCellIndex()
    index.disappeared("a")
    XCTAssertNil(index.cell(at: CGPoint(x: 50, y: 50)))
    XCTAssertEqual(index.cell(at: CGPoint(x: 150, y: 50)), "b")
  }

  func testCellBackOnScreenMatchesWithoutReportingItsFrameAgain() {
    var index = twoCellIndex()
    index.disappeared("a")
    index.appeared("a")
    XCTAssertEqual(index.cell(at: CGPoint(x: 50, y: 50)), "a")
  }

  func testReplacementAppearingBeforeTheOldCellDisappearsStaysMatched() {
    var index = twoCellIndex()
    index.appeared("a")
    index.record(CGRect(x: 300, y: 0, width: 100, height: 100), for: "a")
    index.disappeared("a")
    XCTAssertEqual(index.cell(at: CGPoint(x: 350, y: 50)), "a")
  }

  func testFrameRecordedBeforeTheCellAppearsMatchesOnceItAppears() {
    var index = CellFrameIndex<String>()
    index.record(CGRect(x: 0, y: 0, width: 100, height: 100), for: "a")
    XCTAssertNil(index.cell(at: CGPoint(x: 50, y: 50)))
    index.appeared("a")
    XCTAssertEqual(index.cell(at: CGPoint(x: 50, y: 50)), "a")
  }

  func testUnmatchedDisappearanceDoesNotHideALaterAppearance() {
    var index = CellFrameIndex<String>()
    index.disappeared("a")
    index.disappeared("ghost")
    shownCell(CGRect(x: 0, y: 0, width: 100, height: 100), "a", in: &index)
    XCTAssertEqual(index.cell(at: CGPoint(x: 50, y: 50)), "a")
  }

  func testOnScreenFollowsTheAppearanceCount() {
    var index = CellFrameIndex<String>()
    XCTAssertFalse(index.isOnScreen("a"))
    index.appeared("a")
    index.appeared("a")
    index.disappeared("a")
    XCTAssertTrue(index.isOnScreen("a"))
    index.disappeared("a")
    XCTAssertFalse(index.isOnScreen("a"))
  }

  func testRerecordingACellMovesItsFrame() {
    var index = twoCellIndex()
    index.record(CGRect(x: 300, y: 0, width: 100, height: 100), for: "a")
    XCTAssertNil(index.cell(at: CGPoint(x: 50, y: 50)))
    XCTAssertEqual(index.cell(at: CGPoint(x: 350, y: 50)), "a")
  }

  func testOverlappingFramesResolveToTheMostRecentlyRecorded() {
    var index = CellFrameIndex<String>()
    shownCell(CGRect(x: 0, y: 0, width: 100, height: 100), "old", in: &index)
    shownCell(CGRect(x: 50, y: 0, width: 100, height: 100), "new", in: &index)
    XCTAssertEqual(index.cell(at: CGPoint(x: 75, y: 50)), "new")
    XCTAssertEqual(index.cell(at: CGPoint(x: 25, y: 50)), "old")
    index.disappeared("new")
    XCTAssertEqual(index.cell(at: CGPoint(x: 75, y: 50)), "old")
  }
}
