import XCTest
@testable import MapleUI

final class MuiLabelValueGridTests: XCTestCase {
    func testRowDefaultsToPlainNonLinkValue() {
        let row = MuiLabelValueRow(id: "path", label: "Path", value: "Photos/2026")
        XCTAssertFalse(row.isLink)
    }

    func testRowCanOptIntoLinkRendering() {
        let row = MuiLabelValueRow(id: "path", label: "Path", value: "Photos/2026", isLink: true)
        XCTAssertTrue(row.isLink)
    }

    func testGridDefaultsToNoLinkHandler() {
        let grid = MuiLabelValueGrid(rows: [MuiLabelValueRow(id: "iso", label: "ISO", value: "100")])
        XCTAssertNil(grid.linkTapped)
    }

    func testGridPreservesRowOrderAndIdentity() {
        let rows = [
            MuiLabelValueRow(id: "camera", label: "Camera", value: "DJI Mavic 3 Pro"),
            MuiLabelValueRow(id: "path", label: "Path", value: "Photos/2026", isLink: true),
        ]
        let grid = MuiLabelValueGrid(rows: rows, linkTapped: { _ in })
        XCTAssertEqual(grid.rows.map(\.id), ["camera", "path"])
        XCTAssertNotNil(grid.linkTapped)
    }
}
