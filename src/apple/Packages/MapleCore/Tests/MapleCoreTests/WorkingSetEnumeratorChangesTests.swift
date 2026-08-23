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
        makeEnumeratorWithWorkingSet(session: session, roots: roots).enumerator
    }

    /// Same construction as `makeEnumerator`, but also hands back the
    /// `WorkingSet` so a test can inspect its post-enumeration state —
    /// needed to assert on cache-mutation ordering, which `updates`/
    /// `deletes` alone can't observe.
    private func makeEnumeratorWithWorkingSet(
        session: URLSession,
        roots: [LibraryRoot]
    ) -> (enumerator: WorkingSetEnumerator, workingSet: WorkingSet) {
        let server = URL(string: "https://x.test")!
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let catalog = RemoteCatalog(http: http, server: server, downloadURLSession: session)
        let workingSet = WorkingSet(capacity: 100)
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cursor-\(UUID().uuidString)")
        // Mirrors `ChangeCursorStoreTests`' cleanup pattern — without
        // this, every call leaks a `cursor-<uuid>` directory into the
        // real temp dir for the life of the machine.
        addTeardownBlock { try? FileManager.default.removeItem(at: tmpDir) }
        let cursorStore = ChangeCursorStore(directory: tmpDir)
        let listCache = WorkingSetListCache(catalog: catalog)
        let rootCache = LibraryRootCache(
            domainID: "test-\(UUID().uuidString)",
            defaults: UserDefaults(suiteName: "test-\(UUID().uuidString)"),
            fetcher: { roots }
        )
        let enumerator = WorkingSetEnumerator(
            catalog: catalog,
            workingSet: workingSet,
            cursorStore: cursorStore,
            domainID: "test-domain",
            listCache: listCache,
            rootCache: rootCache
        )
        return (enumerator, workingSet)
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
            // Batch-meta is "unsupported" here (404) so resolution takes
            // the legacy per-asset path this test exercises — a batch
            // 500 would (correctly) abort the whole call instead of
            // stubbing (see WorkingSetEnumeratorBatchResolutionTests).
            if req.url!.path.hasSuffix("/batch-meta") {
                let resp = HTTPURLResponse(url: req.url!, statusCode: 404,
                                           httpVersion: "HTTP/1.1", headerFields: nil)!
                return (Data(), resp)
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

    /// Regression coverage for the jules BLOCKING finding on PR #2687:
    /// `enumerateChanges` used to `await` `catalog.getAsset` sequentially
    /// inside a per-item loop, so a batch of N non-delete rows cost N
    /// sequential round-trips. Drives a batch of 20 rows, each needing a
    /// per-asset metadata GET, and asserts the resolution genuinely
    /// overlaps (not accidentally serialized) while staying at or below
    /// the configured cap (`maxConcurrentMetadataFetches` = 12) — and
    /// that despite completing out of order, the OS still sees the items
    /// back in the change feed's original order.
    func testEnumerateChangesResolvesMetadataConcurrentlyUpToCap() async throws {
        let assetIDs = (0..<20).map { String(format: "%024x", $0 + 1) }
        let inFlight = ConcurrentRequestTracker()
        let session = URLSession.stubbedSequence(
            delay: .milliseconds(20),
            onRequestStart: { await inFlight.enter() },
            onRequestEnd: { await inFlight.leave() }
        ) { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            if req.url!.path.contains("/api/changes") {
                let rows = assetIDs.map { id in
                    """
                    {"cursor": 1, "asset_id": "\(id)", "folder_id": "F1",
                     "kind": "update", "abs_path": "/srv/lib/\(id).dng", "at": "2026-05-16T00:00:00Z"}
                    """
                }.joined(separator: ",")
                let body = "{\"changes\": [\(rows)], \"next_cursor\": 1}"
                return (body.data(using: .utf8)!, resp)
            }
            // GET /api/assets/:id
            let id = (req.url!.path as NSString).lastPathComponent
            let body = """
            {"id": "\(id)", "folder_id": "F1", "filename": "\(id).dng",
             "abs_path": "/srv/lib/\(id).dng", "size": 4096, "mtime": 1700000000000, "rating": 0}
            """
            return (body.data(using: .utf8)!, resp)
        }
        let roots = [root(id: "F1", path: "/srv/lib")]
        let enumerator = makeEnumerator(session: session, roots: roots)
        let observer = TestChangeObserver()
        enumerator.enumerateChanges(for: observer, from: anchor(0))
        let finished = await observer.waitUntilFinished(timeoutSeconds: 10)
        XCTAssertTrue(finished, "enumerateChanges did not finish in time")
        XCTAssertNil(observer.error)
        XCTAssertEqual(observer.updates.count, assetIDs.count)

        let observedMax = await inFlight.observedMax
        XCTAssertGreaterThan(observedMax, 1,
                             "resolution should overlap, not run strictly sequentially")
        XCTAssertLessThanOrEqual(observedMax, 12,
                                 "must not exceed the configured concurrency cap (observed \(observedMax))")

        // Ordering: the task group completes rows out of order, but the
        // OS must still see them back in the change feed's original
        // order.
        let returnedFilenames = observer.updates.compactMap { ($0 as? MapleItem)?.filename }
        XCTAssertEqual(returnedFilenames, assetIDs.map { "\($0).dng" },
                       "enumerateChanges must preserve change-feed ordering despite concurrent resolution")
    }

    /// WARN finding (jules, PR #2687): before this fix, the per-item stub
    /// fallback landed at `.rootContainer` with the hardcoded filename
    /// "(stub)". During a genuine network outage, every non-delete row in
    /// a batch would hit that SAME fallback, producing a pile of
    /// identically-named "(stub)" items colliding at the top level of the
    /// drive. A real connectivity failure (not merely a bad HTTP status —
    /// see `testEnumerateChangesFallsBackToStubWithoutWorkingSetParent`
    /// for that case) must instead abort the whole `enumerateChanges`
    /// call, so the OS retries later against the same (unadvanced)
    /// anchor rather than the extension painting junk into Finder.
    func testEnumerateChangesAbortsOnNetworkUnreachableInsteadOfStubStorm() async throws {
        let assetIDs = (0..<5).map { String(format: "%024x", $0 + 1) }
        let session = URLSession.stubbedSequence(
            errorProvider: { req in
                req.url!.path.contains("/api/assets/") ? URLError(.notConnectedToInternet) : nil
            }
        ) { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            let rows = assetIDs.map { id in
                """
                {"cursor": 3, "asset_id": "\(id)", "folder_id": "F1",
                 "kind": "update", "abs_path": "/srv/lib/\(id).dng", "at": "2026-05-16T00:00:00Z"}
                """
            }.joined(separator: ",")
            let body = "{\"changes\": [\(rows)], \"next_cursor\": 3}"
            return (body.data(using: .utf8)!, resp)
        }
        let roots = [root(id: "F1", path: "/srv/lib")]
        let enumerator = makeEnumerator(session: session, roots: roots)
        let observer = TestChangeObserver()
        enumerator.enumerateChanges(for: observer, from: anchor(0))
        let finished = await observer.waitUntilFinished(timeoutSeconds: 5)
        XCTAssertTrue(finished, "enumerateChanges did not finish in time")
        XCTAssertNotNil(observer.error, "a network outage must fail the enumeration, not stub every row")
        XCTAssertTrue(observer.updates.isEmpty,
                      "no stub items should be handed to the OS during a network outage")
        XCTAssertTrue(observer.deletes.isEmpty)
        let nsError = observer.error as NSError?
        XCTAssertEqual(nsError?.domain, NSFileProviderErrorDomain)
        XCTAssertEqual(nsError?.code, NSFileProviderError.serverUnreachable.rawValue)
    }

    /// Regression coverage for jules' second BLOCKING finding on PR
    /// #2687: `workingSet` mutations used to happen INSIDE each
    /// concurrent row's task, so they landed in COMPLETION order, not
    /// the feed-index order that `didUpdate`/`didDeleteItems` are
    /// carefully reassembled into. A batch with an update for an asset
    /// followed later in the feed by a delete for that SAME asset must
    /// leave the working set without that asset — even if the update's
    /// per-asset metadata GET is slow enough to finish AFTER the
    /// delete's (synchronous, no-network) removal already ran.
    func testEnumerateChangesAppliesWorkingSetMutationsInFeedOrderNotCompletionOrder() async throws {
        let assetID = "dddddddddddddddddddddddd"
        // The delay applies to every request on this session, including
        // the one `/api/changes` call — that's fine, it's still awaited
        // before the concurrent phase begins. What matters is that the
        // update row's `/api/assets/:id` GET is slow relative to the
        // delete row's resolution, which never touches the network at
        // all and so completes near-instantly regardless of the delay.
        let session = URLSession.stubbedSequence(delay: .milliseconds(50)) { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            if req.url!.path.contains("/api/changes") {
                let body = """
                {"changes": [
                  {"cursor": 1, "asset_id": "\(assetID)", "folder_id": "F1",
                   "kind": "update", "abs_path": "/srv/lib/a.dng", "at": "2026-05-16T00:00:00Z"},
                  {"cursor": 2, "asset_id": "\(assetID)", "folder_id": null,
                   "kind": "delete", "abs_path": null, "at": "2026-05-16T00:00:01Z"}
                ], "next_cursor": 2}
                """
                return (body.data(using: .utf8)!, resp)
            }
            // GET /api/assets/:id — the update row's (slow) metadata GET.
            let body = """
            {"id": "\(assetID)", "folder_id": "F1", "filename": "a.dng",
             "abs_path": "/srv/lib/a.dng", "size": 4096, "mtime": 1700000000000, "rating": 0}
            """
            return (body.data(using: .utf8)!, resp)
        }
        let roots = [root(id: "F1", path: "/srv/lib")]
        let (enumerator, workingSet) = makeEnumeratorWithWorkingSet(session: session, roots: roots)
        let observer = TestChangeObserver()
        enumerator.enumerateChanges(for: observer, from: anchor(0))
        let finished = await observer.waitUntilFinished(timeoutSeconds: 5)
        XCTAssertTrue(finished, "enumerateChanges did not finish in time")
        XCTAssertNil(observer.error)

        let assetIdentifier = FileProviderIdentifier.asset(assetID).rawValue
        XCTAssertNil(
            workingSet.entry(for: assetIdentifier),
            "the feed's last word for this asset was a delete — the working set must not still "
            + "list it just because the update row's metadata GET finished after the delete's "
            + "synchronous removal"
        )
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
