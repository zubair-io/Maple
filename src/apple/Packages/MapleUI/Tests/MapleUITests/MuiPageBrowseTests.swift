import XCTest
@testable import MapleUI

final class MuiPageBrowseTests: XCTestCase {
    private let assets: [MuiPageBrowseAsset] = [
        MuiPageBrowseAsset(id: "1", sourceId: "iceland", dateGroupId: "mar", dateGroupLabel: "March", item: MuiCollectionItem(id: "1", url: nil, alt: "A")),
        MuiPageBrowseAsset(id: "2", sourceId: "iceland", dateGroupId: "apr", dateGroupLabel: "April", item: MuiCollectionItem(id: "2", url: nil, alt: "B")),
        MuiPageBrowseAsset(id: "3", sourceId: "faroe", dateGroupId: "apr", dateGroupLabel: "April", item: MuiCollectionItem(id: "3", url: nil, alt: "C")),
    ]

    func testFilteredAssetsWithNoActiveSourceReturnsEverything() {
        XCTAssertEqual(MuiPageBrowse.filteredAssets(assets, activeSourceId: nil).map(\.id), ["1", "2", "3"])
    }

    func testFilteredAssetsWithAllSourceReturnsEverything() {
        XCTAssertEqual(MuiPageBrowse.filteredAssets(assets, activeSourceId: MuiPageBrowse.allSourcesId).map(\.id), ["1", "2", "3"])
    }

    func testFilteredAssetsWithASpecificSourceReturnsOnlyItsAssets() {
        XCTAssertEqual(MuiPageBrowse.filteredAssets(assets, activeSourceId: "faroe").map(\.id), ["3"])
    }

    func testTimelineGroupsBucketsByDateGroupPreservingFirstSeenOrder() {
        let groups = MuiPageBrowse.timelineGroups(from: assets)
        XCTAssertEqual(groups.map(\.id), ["mar", "apr"])
        XCTAssertEqual(groups.map(\.label), ["March", "April"])
        XCTAssertEqual(groups[0].items.map(\.id), ["1"])
        XCTAssertEqual(groups[1].items.map(\.id), ["2", "3"])
    }

    func testTimelineGroupsOnAnEmptyPoolReturnsNoGroups() {
        XCTAssertTrue(MuiPageBrowse.timelineGroups(from: []).isEmpty)
    }
}
