import XCTest
@testable import MapleUI

final class MuiMapSurfaceMathTests: XCTestCase {
    func testGroupByDistanceMergesNearbyAnnotations() {
        let annotations = [
            MuiMapPositionedAnnotation(id: "1", normalizedX: 0, normalizedY: 0, label: "A", thumbnailUrl: nil, screenX: 0, screenY: 0),
            MuiMapPositionedAnnotation(id: "2", normalizedX: 0, normalizedY: 0, label: "B", thumbnailUrl: nil, screenX: 5, screenY: 0),
            MuiMapPositionedAnnotation(id: "3", normalizedX: 0, normalizedY: 0, label: "C", thumbnailUrl: nil, screenX: 200, screenY: 200),
        ]
        let groups = MuiMapSurfaceMath.groupByDistance(annotations, threshold: 40)
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(Set(groups[0].map(\.id)), ["1", "2"])
        XCTAssertEqual(groups[1].map(\.id), ["3"])
    }

    func testToClusterPinReturnsSingleLabelForUnmergedGroup() {
        let annotation = MuiMapPositionedAnnotation(id: "1", normalizedX: 0, normalizedY: 0, label: "Reykjavik", thumbnailUrl: nil, screenX: 10, screenY: 20)
        let pin = MuiMapSurfaceMath.toClusterPin([annotation])
        XCTAssertEqual(pin.label, "Reykjavik")
        XCTAssertNil(pin.count)
        XCTAssertEqual(pin.screenX, 10)
        XCTAssertEqual(pin.screenY, 20)
    }

    func testToClusterPinReturnsCountForMergedGroup() {
        let a = MuiMapPositionedAnnotation(id: "1", normalizedX: 0, normalizedY: 0, label: "A", thumbnailUrl: nil, screenX: 0, screenY: 0)
        let b = MuiMapPositionedAnnotation(id: "2", normalizedX: 0, normalizedY: 0, label: "B", thumbnailUrl: nil, screenX: 10, screenY: 0)
        let pin = MuiMapSurfaceMath.toClusterPin([a, b])
        XCTAssertEqual(pin.count, 2)
        XCTAssertNil(pin.label)
        XCTAssertEqual(pin.screenX, 5)
        XCTAssertEqual(pin.memberIds, ["1", "2"])
    }

    func testHeatmapGridBucketsAndNormalizesByMax() {
        let grid = MuiMapSurfaceMath.heatmapGrid(normalizedPoints: [(0.1, 0.1), (0.1, 0.1), (0.9, 0.9)])
        XCTAssertEqual(grid.count, MuiMapSurfaceMath.heatmapRows)
        XCTAssertEqual(grid[0][0], 1.0)
        XCTAssertEqual(grid[7][7], 0.5)
    }

    func testHeatmapGridEmptyPointsIsAllZero() {
        let grid = MuiMapSurfaceMath.heatmapGrid(normalizedPoints: [])
        XCTAssertTrue(grid.flatMap { $0 }.allSatisfy { $0 == 0 })
    }
}
