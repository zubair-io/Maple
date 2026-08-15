// TrashEnumeratorTests.swift
//
// Issue #2546 — a trashed row with no `asset_id` must not fail the
// whole Trash listing. Exercises the actual `TrashEnumerator` path
// (not just the `TrashItem` decode / `MapleItem(trashed:)` unit
// layers covered elsewhere) so the end-to-end "one bad row degrades
// gracefully" contract is pinned.

import XCTest
import FileProvider
@testable import MapleCore

final class TrashEnumeratorTests: XCTestCase {
    override func setUp() {
        super.setUp()
        StubURLProtocol.register()
        StubURLProtocol.reset()
    }
    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    private func makeCatalog() -> RemoteCatalog {
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

    func testTrashEnumeratorSkipsRowsWithoutAssetIDInsteadOfFailingTheWholePage() async throws {
        // Two valid rows + one row missing `asset_id` (a non-image file
        // the server nonetheless listed as trashed). Pre-#2546 this
        // would have thrown a DecodingError for the whole response;
        // post-#2546 it decodes fine, and the enumerator must surface
        // the two valid rows while silently dropping the third.
        StubURLProtocol.handler = { _ in
            let json = """
            {"items":[
              {"asset_id":"a1","filename":"IMG_1.ARW","original_relative_path":"2024/IMG_1.ARW",
               "trash_relative_path":".maple/trash/2024/IMG_1.ARW","size":100,
               "mtime":"2026-05-15T10:00:00.000Z","deleted_at":"2026-05-15T10:00:01.000Z"},
              {"filename":"notes.txt","original_relative_path":"2024/notes.txt",
               "trash_relative_path":".maple/trash/2024/notes.txt","size":10,
               "mtime":"2026-05-15T10:00:00.000Z","deleted_at":"2026-05-15T10:00:01.000Z"},
              {"asset_id":"a2","filename":"IMG_2.ARW","original_relative_path":"2024/IMG_2.ARW",
               "trash_relative_path":".maple/trash/2024/IMG_2.ARW","size":200,
               "mtime":"2026-05-15T10:00:00.000Z","deleted_at":"2026-05-15T10:00:01.000Z"}
            ],"next_cursor":null}
            """
            return (200, Data(json.utf8), [:])
        }
        let containerID = NSFileProviderItemIdentifier(
            FileProviderIdentifier.trash(folderID: "f1").rawValue
        )
        let enumerator = TrashEnumerator(catalog: makeCatalog(), folderID: "f1", containerIdentifier: containerID)
        let observer = TestEnumerationObserver()
        enumerator.enumerateItems(for: observer, startingAt: NSFileProviderPage(Data()))
        let ok = await observer.waitUntilFinished(timeoutSeconds: 5)
        XCTAssertTrue(ok, "enumeration did not finish in time")
        XCTAssertNil(observer.error, "a row without asset_id must not fail the whole listing")
        let items = observer.batches.flatMap { $0 }
        XCTAssertEqual(items.count, 2, "expected the two indexed rows only, got \(items.map(\.filename))")
        let names = Set(items.map(\.filename))
        XCTAssertEqual(names, Set(["IMG_1.ARW", "IMG_2.ARW"]))
    }
}
