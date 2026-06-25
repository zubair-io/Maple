// GridZoomLevelTests.swift — unit tests for GridZoomLevel (#1550).

import XCTest
@testable import MapleCore

final class GridZoomLevelTests: XCTestCase {
    func testPhoneColumns() {
        XCTAssertEqual(GridZoomLevel.fullWidth.phoneColumns, 1)
        XCTAssertEqual(GridZoomLevel.comfortable.phoneColumns, 3)
        XCTAssertEqual(GridZoomLevel.compact.phoneColumns, 5)
        XCTAssertEqual(GridZoomLevel.dense.phoneColumns, 10)
    }

    func testTargetCellWidthShrinksWithMoreColumns() {
        XCTAssertGreaterThan(GridZoomLevel.comfortable.targetCellWidth, GridZoomLevel.compact.targetCellWidth)
        XCTAssertGreaterThan(GridZoomLevel.compact.targetCellWidth, GridZoomLevel.dense.targetCellWidth)
        XCTAssertEqual(GridZoomLevel.comfortable.targetCellWidth, 130, accuracy: 0.01) // 390/3
    }

    func testZoomClampsAtEnds() {
        XCTAssertEqual(GridZoomLevel.fullWidth.zoomedIn(), .fullWidth)   // already biggest
        XCTAssertEqual(GridZoomLevel.dense.zoomedOut(), .dense)          // already smallest
        XCTAssertEqual(GridZoomLevel.comfortable.zoomedIn(), .fullWidth)
        XCTAssertEqual(GridZoomLevel.comfortable.zoomedOut(), .compact)
    }

    func testZoomInStepsTowardsFewerColumns() {
        XCTAssertEqual(GridZoomLevel.compact.zoomedIn(), .comfortable)
        XCTAssertEqual(GridZoomLevel.dense.zoomedIn(), .compact)
    }

    func testZoomOutStepsTowardsMoreColumns() {
        XCTAssertEqual(GridZoomLevel.fullWidth.zoomedOut(), .comfortable)
        XCTAssertEqual(GridZoomLevel.comfortable.zoomedOut(), .compact)
    }

    func testCaseIterableOrder() {
        // rawValue ordering: fullWidth=0, comfortable=1, compact=2, dense=3
        let allCases = GridZoomLevel.allCases
        XCTAssertEqual(allCases.count, 4)
        XCTAssertEqual(allCases.first, .fullWidth)
        XCTAssertEqual(allCases.last, .dense)
    }

    func testRoundTripCodable() throws {
        for level in GridZoomLevel.allCases {
            let data = try JSONEncoder().encode(level)
            let decoded = try JSONDecoder().decode(GridZoomLevel.self, from: data)
            XCTAssertEqual(decoded, level)
        }
    }
}
