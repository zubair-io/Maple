import XCTest
import FileProvider
@testable import MapleCore

final class FolderChangeMatchingTests: XCTestCase {
    private func change(cursor: Int64,
                        assetID: String?,
                        kind: AssetChangeKind,
                        folderID: String?,
                        relativePath: String?) -> AssetChange {
        AssetChange(cursor: cursor,
                    assetID: assetID,
                    folderID: folderID,
                    kind: kind,
                    absPath: nil,
                    relativePath: relativePath,
                    at: Date(timeIntervalSince1970: 0))
    }

    func testAnchorRoundTripsCursor() {
        XCTAssertEqual(FolderChangeMatching.parseAnchor(FolderChangeMatching.anchor(42)), 42)
    }

    func testAnchorParsesZeroForGarbage() {
        let garbage = NSFileProviderSyncAnchor(Data("not-a-number".utf8))
        XCTAssertEqual(FolderChangeMatching.parseAnchor(garbage), 0)
    }

    func testBelongsMatchesAssetDirectlyInFolder() {
        let c = change(cursor: 1, assetID: "a1", kind: .update,
                       folderID: "F1", relativePath: "trips/iceland/DSC_1.dng")
        XCTAssertTrue(FolderChangeMatching.belongs(change: c,
                                                   toFolderID: "F1",
                                                   relativePath: "trips/iceland"))
    }

    func testBelongsRejectsNestedSubfolder() {
        // A change one level deeper belongs to that subfolder, not this one.
        let c = change(cursor: 1, assetID: "a1", kind: .update,
                       folderID: "F1", relativePath: "trips/iceland/day2/DSC_1.dng")
        XCTAssertFalse(FolderChangeMatching.belongs(change: c,
                                                    toFolderID: "F1",
                                                    relativePath: "trips/iceland"))
    }

    func testBelongsMatchesLibraryRootLevelAsset() {
        let c = change(cursor: 1, assetID: "a1", kind: .update,
                       folderID: "F1", relativePath: "DSC_1.dng")
        XCTAssertTrue(FolderChangeMatching.belongs(change: c,
                                                   toFolderID: "F1",
                                                   relativePath: ""))
    }

    func testBelongsRejectsDifferentLibrary() {
        let c = change(cursor: 1, assetID: "a1", kind: .update,
                       folderID: "F2", relativePath: "trips/iceland/DSC_1.dng")
        XCTAssertFalse(FolderChangeMatching.belongs(change: c,
                                                    toFolderID: "F1",
                                                    relativePath: "trips/iceland"))
    }

    func testBelongsRejectsUnresolvableRow() {
        // Legacy payloads carry no relativePath — we cannot place them, so
        // they must not be claimed by any folder.
        let c = change(cursor: 1, assetID: "a1", kind: .update,
                       folderID: "F1", relativePath: nil)
        XCTAssertFalse(FolderChangeMatching.belongs(change: c,
                                                    toFolderID: "F1",
                                                    relativePath: ""))
    }

    func testPartitionSplitsUpdatesAndDeletes() {
        let changes = [
            change(cursor: 1, assetID: "a1", kind: .update,
                   folderID: "F1", relativePath: "d/one.dng"),
            change(cursor: 2, assetID: "a2", kind: .delete,
                   folderID: "F1", relativePath: "d/two.dng"),
            change(cursor: 3, assetID: "a3", kind: .update,
                   folderID: "F1", relativePath: "other/three.dng"),
            change(cursor: 4, assetID: nil, kind: .update,
                   folderID: "F1", relativePath: "d/four.dng"),
        ]
        let out = FolderChangeMatching.partition(changes: changes,
                                                 folderID: "F1",
                                                 relativePath: "d")
        XCTAssertEqual(out.updates.map(\.filename), ["one.dng"])
        XCTAssertEqual(out.deletes.map(\.rawValue),
                       [FileProviderIdentifier.asset("a2").rawValue])
    }

    func testPartitionGivesUpdatesTheRealFolderParent() {
        let changes = [change(cursor: 7, assetID: "a1", kind: .update,
                              folderID: "F1", relativePath: "d/one.dng")]
        let out = FolderChangeMatching.partition(changes: changes,
                                                 folderID: "F1",
                                                 relativePath: "d")
        let expected = FileProviderIdentifier.folder(folderID: "F1", relativePath: "d").rawValue
        XCTAssertEqual(out.updates.first?.parentItemIdentifier.rawValue, expected)
    }
}
