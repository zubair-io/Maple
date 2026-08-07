// src/apple/Packages/MapleCore/Tests/MapleCoreTests/WorkingSetEnumeratorChangesTests.swift
//
// Coverage for #2537: a synthetic stub item (literal "(stub)" filename,
// `.workingSet` parent) could persist in Finder because the OS treats
// `enumerateChanges`'s `didUpdate` items as authoritative without
// promptly re-invoking `item(for:)`. `WorkingSetEnumerator.enumerateChanges`
// now resolves each non-delete change's real metadata inline via a
// per-asset GET (`RemoteCatalog.getAsset`), so the OS gets a real
// filename + a real folder parent on the very first call. These tests
// drive `enumerateChanges` end-to-end against a stubbed `RemoteCatalog`
// and assert on the items handed to a fake `NSFileProviderChangeObserver`.

import FileProvider
import XCTest
@testable import MapleCore

final class WorkingSetEnumeratorChangesTests: XCTestCase {
    private func root(id: String, path: String) -> LibraryRoot {
        LibraryRoot(id: id, path: path, label: id, fileCount: 0)
    }

    private func makeEnumerator(
        session: URLSession,
        roots: [LibraryRoot]
    ) -> WorkingSetEnumerator {
        let server = URL(string: "https://x.test")!
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let catalog = RemoteCatalog(http: http, server: server, downloadURLSession: session)
        let workingSet = WorkingSet(capacity: 100)
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cursor-\(UUID().uuidString)")
        let cursorStore = ChangeCursorStore(directory: tmpDir)
        let listCache = WorkingSetListCache(catalog: catalog)
        let rootCache = LibraryRootCache(
            domainID: "test-\(UUID().uuidString)",
            defaults: UserDefaults(suiteName: "test-\(UUID().uuidString)"),
            fetcher: { roots }
        )
        return WorkingSetEnumerator(
            catalog: catalog,
            workingSet: workingSet,
            cursorStore: cursorStore,
            domainID: "test-domain",
            listCache: listCache,
            rootCache: rootCache
        )
    }

    private func anchor(_ cursor: Int64) -> NSFileProviderSyncAnchor {
        NSFileProviderSyncAnchor(String(cursor).data(using: .utf8)!)
    }

    /// The common path: the change-feed row lacks `relativePath` (a
    /// legacy/degraded payload — the exact trigger from #2537), but the
    /// per-asset GET succeeds. The OS must receive the asset's real
    /// filename, never the literal "(stub)", and a real folder parent,
    /// never `.workingSet`.
    func testEnumerateChangesResolvesRealMetadataInsteadOfStub() async throws {
        let assetID = "aaaaaaaaaaaaaaaaaaaaaaaa"
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            if req.url!.path.contains("/api/changes") {
                let body = """
                {"changes": [
                  {"cursor": 5, "asset_id": "\(assetID)", "folder_id": "F1",
                   "kind": "update", "abs_path": "/srv/lib/2026/IMG_9.dng", "at": "2026-05-16T00:00:00Z"}
                ], "next_cursor": 5}
                """
                return (body.data(using: .utf8)!, resp)
            }
            // GET /api/assets/:id
            let body = """
            {"id": "\(assetID)", "folder_id": "F1", "filename": "IMG_9.dng",
             "abs_path": "/srv/lib/2026/IMG_9.dng", "size": 4096, "mtime": 1700000000000, "rating": 0}
            """
            return (body.data(using: .utf8)!, resp)
        }
        let roots = [root(id: "F1", path: "/srv/lib")]
        let enumerator = makeEnumerator(session: session, roots: roots)
        let observer = TestChangeObserver()
        enumerator.enumerateChanges(for: observer, from: anchor(0))
        let finished = await observer.waitUntilFinished(timeoutSeconds: 5)
        XCTAssertTrue(finished, "enumerateChanges did not finish in time")
        XCTAssertNil(observer.error)
        XCTAssertEqual(observer.updates.count, 1)
        guard let item = observer.updates.first as? MapleItem else {
            return XCTFail("expected a MapleItem")
        }
        XCTAssertEqual(item.filename, "IMG_9.dng")
        XCTAssertNotEqual(item.filename, "(stub)")
        XCTAssertEqual(
            item.parentItemIdentifier.rawValue,
            FileProviderIdentifier.folder(folderID: "F1", relativePath: "2026").rawValue,
            "parent must be the asset's real folder, not .workingSet"
        )
        XCTAssertNotEqual(item.parentItemIdentifier, .workingSet)
    }

    /// The per-asset GET 404s (change-feed row raced a server-side
    /// delete). The asset must be reported as a delete, not handed back
    /// as an item whose content will 404 forever.
    func testEnumerateChangesTreats404AsDelete() async throws {
        let assetID = "bbbbbbbbbbbbbbbbbbbbbbbb"
        let session = URLSession.stubbedSequence { req in
            if req.url!.path.contains("/api/changes") {
                let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                           httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
                let body = """
                {"changes": [
                  {"cursor": 7, "asset_id": "\(assetID)", "folder_id": "F1",
                   "kind": "create", "abs_path": null, "at": "2026-05-16T00:00:00Z"}
                ], "next_cursor": 7}
                """
                return (body.data(using: .utf8)!, resp)
            }
            let resp = HTTPURLResponse(url: req.url!, statusCode: 404,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(), resp)
        }
        let enumerator = makeEnumerator(session: session, roots: [])
        let observer = TestChangeObserver()
        enumerator.enumerateChanges(for: observer, from: anchor(0))
        let finished = await observer.waitUntilFinished(timeoutSeconds: 5)
        XCTAssertTrue(finished, "enumerateChanges did not finish in time")
        XCTAssertNil(observer.error)
        XCTAssertTrue(observer.updates.isEmpty)
        XCTAssertEqual(observer.deletes.map(\.rawValue),
                       [FileProviderIdentifier.asset(assetID).rawValue])
    }

    /// The per-asset GET fails transiently (network/5xx). The
    /// enumerator must still hand back a placeholder so the OS re-asks
    /// later, but its parent must never be `.workingSet` — that
    /// identifier is unconditionally `noSuchItem` (see
    /// `FileProviderExtensionCore.item(for:)`), so an item parented
    /// there can never resolve.
    func testEnumerateChangesFallsBackToStubWithoutWorkingSetParent() async throws {
        let assetID = "cccccccccccccccccccccccc"
        let session = URLSession.stubbedSequence { req in
            if req.url!.path.contains("/api/changes") {
                let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                           httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
                // No folder_id / abs_path on this row — legacy payload.
                let body = """
                {"changes": [
                  {"cursor": 9, "asset_id": "\(assetID)", "folder_id": null,
                   "kind": "update", "abs_path": null, "at": "2026-05-16T00:00:00Z"}
                ], "next_cursor": 9}
                """
                return (body.data(using: .utf8)!, resp)
            }
            // Simulate a transient server failure on the per-asset GET.
            let resp = HTTPURLResponse(url: req.url!, statusCode: 500,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(), resp)
        }
        let enumerator = makeEnumerator(session: session, roots: [])
        let observer = TestChangeObserver()
        enumerator.enumerateChanges(for: observer, from: anchor(0))
        let finished = await observer.waitUntilFinished(timeoutSeconds: 5)
        XCTAssertTrue(finished, "enumerateChanges did not finish in time")
        XCTAssertNil(observer.error)
        XCTAssertEqual(observer.updates.count, 1)
        guard let item = observer.updates.first as? MapleItem else {
            return XCTFail("expected a MapleItem")
        }
        XCTAssertNotEqual(item.parentItemIdentifier, .workingSet,
                          ".workingSet is permanently noSuchItem — never a valid fallback parent")
        XCTAssertEqual(item.parentItemIdentifier, .rootContainer)
    }
}

/// Test helper — records `NSFileProviderChangeObserver` callbacks and
/// exposes an async wait, mirroring `TestEnumerationObserver` in
/// `FolderEnumeratorPagingTests.swift`.
final class TestChangeObserver: NSObject, NSFileProviderChangeObserver, @unchecked Sendable {
    var updates: [NSFileProviderItem] = []
    var deletes: [NSFileProviderItemIdentifier] = []
    var finished = false
    var error: Error?
    private let cv = NSCondition()

    func didUpdate(_ updatedItems: [NSFileProviderItemProtocol]) {
        cv.lock()
        updates.append(contentsOf: updatedItems as! [NSFileProviderItem])
        cv.unlock()
    }

    func didDeleteItems(withIdentifiers deletedItemIdentifiers: [NSFileProviderItemIdentifier]) {
        cv.lock()
        deletes.append(contentsOf: deletedItemIdentifiers)
        cv.unlock()
    }

    func finishEnumeratingChanges(upTo newAnchor: NSFileProviderSyncAnchor, moreComing: Bool) {
        cv.lock(); finished = true; cv.signal(); cv.unlock()
    }

    func finishEnumeratingWithError(_ error: Error) {
        cv.lock(); self.error = error; finished = true; cv.signal(); cv.unlock()
    }

    func waitUntilFinished(timeoutSeconds: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            cv.lock()
            let done = finished
            cv.unlock()
            if done { return true }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return false
    }
}
