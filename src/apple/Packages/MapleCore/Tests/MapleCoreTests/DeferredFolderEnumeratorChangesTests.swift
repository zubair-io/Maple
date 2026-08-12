import XCTest
import FileProvider
@testable import MapleCore

final class DeferredFolderEnumeratorChangesTests: XCTestCase {
    override func setUp() {
        super.setUp()
        StubURLProtocol.register()
        StubURLProtocol.reset()
    }

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    /// Collects observer callbacks so assertions can inspect them.
    private final class ChangeObserver: NSObject, NSFileProviderChangeObserver {
        var updated: [NSFileProviderItemProtocol] = []
        var deleted: [NSFileProviderItemIdentifier] = []
        var finishedAnchor: NSFileProviderSyncAnchor?
        var moreComing: Bool?
        var failure: Error?
        let done = XCTestExpectation(description: "enumerateChanges finished")

        func didUpdate(_ updatedItems: [NSFileProviderItemProtocol]) {
            updated.append(contentsOf: updatedItems)
        }
        func didDeleteItems(withIdentifiers identifiers: [NSFileProviderItemIdentifier]) {
            deleted.append(contentsOf: identifiers)
        }
        func finishEnumeratingChanges(upTo anchor: NSFileProviderSyncAnchor, moreComing: Bool) {
            finishedAnchor = anchor
            self.moreComing = moreComing
            done.fulfill()
        }
        func finishEnumeratingWithError(_ error: Error) {
            failure = error
            done.fulfill()
        }
    }

    /// Builds a `DeferredFolderEnumerator` wired to a `RemoteCatalog` over
    /// `StubURLProtocol` (same shape as `FolderEnumeratorPagingTests`) and a
    /// `ChangeCursorStore` rooted at a throwaway temp directory so runs
    /// don't share state.
    private func makeEnumerator(folderID: String, relativePath: String) -> DeferredFolderEnumerator {
        let session = TestURLSession.make()
        let http = AuthenticatedHTTPClient(
            server: URL(string: "https://x.test")!,
            urlSession: session,
            tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
            onTokensRefreshed: { _ in },
            onSignOut: {}
        )
        let catalog = RemoteCatalog(http: http,
                                    server: URL(string: "https://x.test")!,
                                    downloadURLSession: session)
        let rootCache = LibraryRootCache(
            domainID: "d",
            defaults: UserDefaults(suiteName: "test-\(UUID().uuidString)")!,
            fetcher: { [] }
        )
        let cursorDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("DeferredFolderEnumeratorChangesTests-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: cursorDir) }
        let cursorStore = ChangeCursorStore(directory: cursorDir)
        let containerIdentifier = NSFileProviderItemIdentifier(
            FileProviderIdentifier.folder(folderID: folderID, relativePath: relativePath).rawValue
        )
        return DeferredFolderEnumerator(catalog: catalog,
                                        rootCache: rootCache,
                                        folderID: folderID,
                                        relativePath: relativePath,
                                        containerIdentifier: containerIdentifier,
                                        cursorStore: cursorStore,
                                        domainID: "d")
    }

    func testDeliversOnlyThisFoldersChangesAndAdvancesTheAnchor() {
        StubURLProtocol.handler = { _ in
            let body = """
            {"changes":[
              {"cursor":11,"asset_id":"a1","folder_id":"F1","kind":"update","abs_path":null,"relative_path":"d/one.dng","at":"2026-08-12T00:00:00.000Z"},
              {"cursor":12,"asset_id":"a2","folder_id":"F1","kind":"delete","abs_path":null,"relative_path":"d/two.dng","at":"2026-08-12T00:00:00.000Z"},
              {"cursor":13,"asset_id":"a3","folder_id":"F1","kind":"update","abs_path":null,"relative_path":"elsewhere/three.dng","at":"2026-08-12T00:00:00.000Z"}
            ],"next_cursor":13}
            """
            return (200, Data(body.utf8), [:])
        }

        let enumerator = makeEnumerator(folderID: "F1", relativePath: "d")
        let observer = ChangeObserver()
        enumerator.enumerateChanges(for: observer, from: FolderChangeMatching.anchor(10))
        wait(for: [observer.done], timeout: 5)

        XCTAssertNil(observer.failure)
        XCTAssertEqual(observer.updated.map(\.filename), ["one.dng"])
        XCTAssertEqual(observer.deleted.map(\.rawValue),
                       [FileProviderIdentifier.asset("a2").rawValue])
        // Anchor advances past the whole page even though one row was
        // filtered out — otherwise we would re-scan it forever.
        XCTAssertEqual(observer.finishedAnchor.map(FolderChangeMatching.parseAnchor), 13)
        XCTAssertEqual(observer.moreComing, false)
    }

    func testStaleCursorRequestsFullReEnumeration() {
        StubURLProtocol.handler = { _ in
            (409, Data(#"{"error":"stale cursor","current":99}"#.utf8), [:])
        }

        let enumerator = makeEnumerator(folderID: "F1", relativePath: "d")
        let observer = ChangeObserver()
        enumerator.enumerateChanges(for: observer, from: FolderChangeMatching.anchor(1))
        wait(for: [observer.done], timeout: 5)

        let ns = observer.failure as NSError?
        XCTAssertEqual(ns?.domain, NSFileProviderErrorDomain)
        XCTAssertEqual(ns?.code, NSFileProviderError.syncAnchorExpired.rawValue)
    }
}
