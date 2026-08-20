// src/apple/Packages/MapleCore/Tests/MapleCoreTests/WorkingSetEnumeratorFileChangesTests.swift
//
// Coverage for #2535: every `FileChild`-backed change-feed row (video,
// PDF, extensionless — anything not an indexed image) has `asset_id:
// null`. `WorkingSetEnumerator.enumerateChanges` used to unconditionally
// drop these rows (`guard let assetID = ch.assetID else { return .skip }`)
// before the working set — or any update/delete list — ever saw them, so
// non-image files never live-updated in Finder. These tests drive
// `enumerateChanges` end-to-end against a stubbed `RemoteCatalog` and
// assert the file rows are now resolved via `(folder_id, relative_path)`
// instead of discarded — mirroring `WorkingSetEnumeratorChangesTests`'
// pattern for the asset-ID case.

import FileProvider
import XCTest
@testable import MapleCore

final class WorkingSetEnumeratorFileChangesTests: XCTestCase {
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
        addTeardownBlock { try? FileManager.default.removeItem(at: tmpDir) }
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

    /// The core regression: a change row with no `asset_id` but a real
    /// `folder_id` + `relative_path` (exactly what the server now emits
    /// for a non-asset file create/update, e.g. `POST /:id/upload`'s
    /// non-media branch or `POST /:id/file/relocate`) must resolve to a
    /// real `.file`-identified `MapleItem` — never silently dropped.
    func testEnumerateChangesResolvesFileRowViaStatFile() async throws {
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            if req.url!.path.contains("/api/changes") {
                let body = """
                {"changes": [
                  {"cursor": 5, "asset_id": null, "folder_id": "F1",
                   "kind": "create", "abs_path": "/srv/lib/docs/notes.pdf",
                   "relative_path": "docs/notes.pdf", "at": "2026-05-16T00:00:00Z"}
                ], "next_cursor": 5}
                """
                return (body.data(using: .utf8)!, resp)
            }
            // GET /api/folders/F1/file-meta
            XCTAssertTrue(req.url!.path.contains("/file-meta"))
            let body = """
            {"name": "notes.pdf", "path": "/srv/lib/docs/notes.pdf",
             "mtime": "2026-05-16T00:00:00Z", "size": 4096, "ext": "pdf"}
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
        XCTAssertEqual(observer.updates.count, 1,
                       "a folder_id+relative_path-bearing row with no asset_id must NOT be dropped")
        guard let item = observer.updates.first as? MapleItem else {
            return XCTFail("expected a MapleItem")
        }
        XCTAssertEqual(item.filename, "notes.pdf")
        XCTAssertEqual(
            item.itemIdentifier.rawValue,
            FileProviderIdentifier.file(folderID: "F1", relativePath: "docs/notes.pdf").rawValue
        )
        XCTAssertEqual(
            item.parentItemIdentifier.rawValue,
            FileProviderIdentifier.folder(folderID: "F1", relativePath: "docs").rawValue
        )
    }

    /// A `delete` row for a non-asset file resolves synchronously (no
    /// network round-trip) to a `.file`-identified deletion — mirroring
    /// the asset case's `ch.kind == .delete` fast path.
    func testEnumerateChangesResolvesFileDeleteRowDirectly() async throws {
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            let body = """
            {"changes": [
              {"cursor": 6, "asset_id": null, "folder_id": "F1",
               "kind": "delete", "abs_path": "/srv/lib/clip.mov",
               "relative_path": "clip.mov", "at": "2026-05-16T00:00:00Z"}
            ], "next_cursor": 6}
            """
            return (body.data(using: .utf8)!, resp)
        }
        let enumerator = makeEnumerator(session: session, roots: [])
        let observer = TestChangeObserver()
        enumerator.enumerateChanges(for: observer, from: anchor(0))
        let finished = await observer.waitUntilFinished(timeoutSeconds: 5)
        XCTAssertTrue(finished, "enumerateChanges did not finish in time")
        XCTAssertNil(observer.error)
        XCTAssertTrue(observer.updates.isEmpty)
        XCTAssertEqual(
            observer.deletes.map(\.rawValue),
            [FileProviderIdentifier.file(folderID: "F1", relativePath: "clip.mov").rawValue]
        )
    }

    /// The file-meta GET 404s (the change-feed row raced a server-side
    /// delete/move). Reported as a delete, not a stub whose content will
    /// 404 forever — mirrors `testEnumerateChangesTreats404AsDelete`.
    func testEnumerateChangesTreatsFileRow404AsDelete() async throws {
        let session = URLSession.stubbedSequence { req in
            if req.url!.path.contains("/api/changes") {
                let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                           httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
                let body = """
                {"changes": [
                  {"cursor": 7, "asset_id": null, "folder_id": "F1",
                   "kind": "update", "abs_path": "/srv/lib/gone.pdf",
                   "relative_path": "gone.pdf", "at": "2026-05-16T00:00:00Z"}
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
        XCTAssertEqual(
            observer.deletes.map(\.rawValue),
            [FileProviderIdentifier.file(folderID: "F1", relativePath: "gone.pdf").rawValue]
        )
    }

    /// A row with neither `asset_id` NOR a resolvable `relative_path` has
    /// no way to be addressed at all — must still be skipped (not crash,
    /// not synthesize a bogus identifier), matching the pre-#2535
    /// behaviour for that one irreducible case.
    func testEnumerateChangesSkipsRowWithNeitherAssetIdNorRelativePath() async throws {
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            let body = """
            {"changes": [
              {"cursor": 8, "asset_id": null, "folder_id": null,
               "kind": "update", "abs_path": null, "at": "2026-05-16T00:00:00Z"}
            ], "next_cursor": 8}
            """
            return (body.data(using: .utf8)!, resp)
        }
        let enumerator = makeEnumerator(session: session, roots: [])
        let observer = TestChangeObserver()
        enumerator.enumerateChanges(for: observer, from: anchor(0))
        let finished = await observer.waitUntilFinished(timeoutSeconds: 5)
        XCTAssertTrue(finished, "enumerateChanges did not finish in time")
        XCTAssertNil(observer.error)
        XCTAssertTrue(observer.updates.isEmpty)
        XCTAssertTrue(observer.deletes.isEmpty)
    }
}
