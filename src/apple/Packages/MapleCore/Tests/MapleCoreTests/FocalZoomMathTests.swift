import XCTest
@testable import MapleCore

final class FocalZoomMathTests: XCTestCase {

    func testPositiveModHandlesNegatives() {
        XCTAssertEqual(FocalZoomMath.positiveMod(-1, 5), 4)
        XCTAssertEqual(FocalZoomMath.positiveMod(-5, 5), 0)
        XCTAssertEqual(FocalZoomMath.positiveMod(7, 5), 2)
        XCTAssertEqual(FocalZoomMath.positiveMod(3, 1), 0)
        XCTAssertEqual(FocalZoomMath.positiveMod(3, 0), 0) // guard
    }

    func testTargetColumnZoomInKeepsSide() {
        // 5 columns -> 3 columns.
        XCTAssertEqual(FocalZoomMath.targetColumn(colOld: 0, nOld: 5, nNew: 3, zoomingIn: true), 0) // far left stays left
        XCTAssertEqual(FocalZoomMath.targetColumn(colOld: 4, nOld: 5, nNew: 3, zoomingIn: true), 2) // far right stays right
        XCTAssertEqual(FocalZoomMath.targetColumn(colOld: 2, nOld: 5, nNew: 3, zoomingIn: true), 1) // center stays center
    }

    func testTargetColumnZoomInToSingleColumn() {
        XCTAssertEqual(FocalZoomMath.targetColumn(colOld: 4, nOld: 5, nNew: 1, zoomingIn: true), 0)
        XCTAssertEqual(FocalZoomMath.targetColumn(colOld: 0, nOld: 3, nNew: 1, zoomingIn: true), 0)
    }

    func testTargetColumnZoomOutCenters() {
        XCTAssertEqual(FocalZoomMath.targetColumn(colOld: 0, nOld: 3, nNew: 5, zoomingIn: false), 2) // center of 5
        XCTAssertEqual(FocalZoomMath.targetColumn(colOld: 2, nOld: 3, nNew: 10, zoomingIn: false), 4) // (10-1)/2
        XCTAssertEqual(FocalZoomMath.targetColumn(colOld: 0, nOld: 1, nNew: 3, zoomingIn: false), 1)
    }

    func testLeadingSpacersLandsFocalInTargetColumn() {
        // For a range of slots/counts, (globalSlot + S) % nNew must equal targetColumn.
        for nNew in 2...12 {
            for g in 0...40 {
                for targetCol in 0..<nNew {
                    let s = FocalZoomMath.leadingSpacers(globalSlot: g, nNew: nNew, targetColumn: targetCol)
                    XCTAssertTrue((0..<nNew).contains(s), "S out of range for g=\(g) n=\(nNew)")
                    XCTAssertEqual((g + s) % nNew, targetCol, "g=\(g) n=\(nNew) target=\(targetCol) gave S=\(s)")
                }
            }
        }
    }

    func testLeadingSpacersSingleColumnIsZero() {
        XCTAssertEqual(FocalZoomMath.leadingSpacers(globalSlot: 7, nNew: 1, targetColumn: 0), 0)
    }

    func testAdaptiveColumnCount() {
        // .adaptive(minimum: 105, gap: 4): how many fit in 400pt?
        // floor((400+4)/(105+4)) = floor(404/109) = 3
        XCTAssertEqual(FocalZoomMath.adaptiveColumnCount(contentWidth: 400, minCell: 105, gap: 4), 3)
        // 340pt cells in 400pt -> 1
        XCTAssertEqual(FocalZoomMath.adaptiveColumnCount(contentWidth: 400, minCell: 340, gap: 4), 1)
        // wide window, 220pt cells: floor((1400+4)/224) = 6
        XCTAssertEqual(FocalZoomMath.adaptiveColumnCount(contentWidth: 1400, minCell: 220, gap: 4), 6)
        // degenerate
        XCTAssertEqual(FocalZoomMath.adaptiveColumnCount(contentWidth: 0, minCell: 105, gap: 4), 1)
    }
}
