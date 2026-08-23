import XCTest
@testable import MapleUI

final class MuiPageTVMapTests: XCTestCase {
    private let assets: [MuiPageTVMapAsset] = [
        MuiPageTVMapAsset(id: "1", annotation: MuiMapSurfaceAnnotation(id: "1", x: 0.1, y: 0.1), favorite: true),
        MuiPageTVMapAsset(id: "2", annotation: MuiMapSurfaceAnnotation(id: "2", x: 0.2, y: 0.2), favorite: false),
    ]

    func testAllTabReturnsEveryAnnotation() {
        XCTAssertEqual(MuiPageTVMap.annotations(for: "all", in: assets).map(\.id), ["1", "2"])
    }

    func testFavoritesTabReturnsOnlyFavoritedAnnotations() {
        XCTAssertEqual(MuiPageTVMap.annotations(for: "favorites", in: assets).map(\.id), ["1"])
    }

    func testAnUnrecognizedTabFailsClosedToFavoritesOnly() {
        XCTAssertEqual(MuiPageTVMap.annotations(for: "unknown", in: assets).map(\.id), ["1"])
    }
}
