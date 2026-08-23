import XCTest
@testable import MapleUI

final class MuiPageTVTimelineTests: XCTestCase {
    func testFlattenedItemsConcatenatesGroupsInOrder() {
        let groups = [
            MuiTimelineGroup(id: "mar", label: "March", items: [MuiCollectionItem(id: "1", url: nil, alt: "A"), MuiCollectionItem(id: "2", url: nil, alt: "B")]),
            MuiTimelineGroup(id: "apr", label: "April", items: [MuiCollectionItem(id: "3", url: nil, alt: "C")]),
        ]
        XCTAssertEqual(MuiPageTVTimeline.flattenedItems(from: groups).map(\.id), ["1", "2", "3"])
    }

    func testFlattenedItemsOnEmptyGroupsReturnsAnEmptyArray() {
        XCTAssertTrue(MuiPageTVTimeline.flattenedItems(from: []).isEmpty)
    }

    func testFlattenedItemsSkipsAnEmptyGroupWithoutInsertingAGap() {
        let groups = [
            MuiTimelineGroup(id: "mar", label: "March", items: []),
            MuiTimelineGroup(id: "apr", label: "April", items: [MuiCollectionItem(id: "3", url: nil, alt: "C")]),
        ]
        XCTAssertEqual(MuiPageTVTimeline.flattenedItems(from: groups).map(\.id), ["3"])
    }
}
