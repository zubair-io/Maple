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

    private func makeCatalogForAnchorTest() -> RemoteCatalog {
        let session = TestURLSession.make()
        let http = AuthenticatedHTTPClient(
            server: URL(string: "https://x.test")!,
            urlSession: session,
            tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
            onTokensRefreshed: { _ in },
            onSignOut: {}
        )
        return RemoteCatalog(http: http,
                             server: URL(string: "https://x.test")!,
                             downloadURLSession: session)
    }

    func testFolderEnumeratorWithoutCursorStoreKeepsAConstantAnchor() {
        // Constructed without a cursor store (the item-listing path used by
        // DeferredFolderEnumerator), it has no cursor source, so it must
        // report a stable anchor rather than a fabricated one.
        let enumerator = FolderEnumerator(catalog: makeCatalogForAnchorTest(),
                                          folderID: "F1",
                                          relativePath: "d",
                                          absolutePath: "/lib/d",
                                          containerIdentifier: .rootContainer)
        let done = XCTestExpectation(description: "anchor")
        var seen: Int64?
        enumerator.currentSyncAnchor { anchor in
            seen = anchor.map(FolderChangeMatching.parseAnchor)
            done.fulfill()
        }
        wait(for: [done], timeout: 2)
        XCTAssertEqual(seen, 0)
    }

    /// Companion to the fallback test above: WITH a cursor store injected
    /// (the shape `DeferredFolderEnumerator` uses in production),
    /// `FolderEnumerator` must report the real persisted cursor rather than
    /// the constant fallback. Written because the fallback test alone
    /// cannot fail against the pre-Task-3 code — the hardcoded anchor it
    /// replaces already returns 0 — so it proves nothing on its own about
    /// the cursor-store path this task adds.
    func testFolderEnumeratorWithCursorStoreReportsPersistedAnchor() {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("FolderEnumeratorAnchorTest-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let cursorStore = ChangeCursorStore(directory: dir)
        cursorStore.save(42, domain: "d1")
        let enumerator = FolderEnumerator(catalog: makeCatalogForAnchorTest(),
                                          folderID: "F1",
                                          relativePath: "d",
                                          absolutePath: "/lib/d",
                                          containerIdentifier: .rootContainer,
                                          changeCursor: (store: cursorStore, domainID: "d1"))
        let done = XCTestExpectation(description: "anchor")
        var seen: Int64?
        enumerator.currentSyncAnchor { anchor in
            seen = anchor.map(FolderChangeMatching.parseAnchor)
            done.fulfill()
        }
        wait(for: [done], timeout: 2)
        XCTAssertEqual(seen, 42)
    }
}
