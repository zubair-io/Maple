// src/apple/Packages/MapleCore/Tests/MapleCoreTests/WorkingSetEnumeratorBatchResolutionTests.swift
//
// #2995: `WorkingSetChangeResolver` used to make one `GET /api/assets/:id`
// round trip PER change-feed row. Draining a backlog at the 500-row page
// limit cost ~502 requests per `enumerateChanges` call and pinned the iPad
// extension at ~300 req/s for minutes. These tests pin the fixed contract:
//   - one `POST /api/assets/batch-meta` resolves the whole page,
//   - duplicate rows for the same asset resolve once (last row wins),
//   - ids absent from the batch response surface as deletes (they raced a
//     server-side delete, mirroring the single route's 404),
//   - a server without the batch route (404) falls back to the legacy
//     per-asset GET path, so a new extension still works against an old
//     Self Hosted server.

import FileProvider
import Foundation
import XCTest
@testable import MapleCore

final class WorkingSetEnumeratorBatchResolutionTests: XCTestCase {
    /// Thread-safe request recorder — `stubbedSequence`'s provider runs on
    /// URLProtocol worker threads, so counts need their own lock.
    private final class RequestLog: @unchecked Sendable {
        private let lock = NSLock()
        private var paths: [String] = []
        func record(_ req: URLRequest) {
            lock.lock()
            defer { lock.unlock() }
            paths.append("\(req.httpMethod ?? "GET") \(req.url!.path)")
        }
        func count(where predicate: (String) -> Bool) -> Int {
            lock.lock()
            defer { lock.unlock() }
            return paths.filter(predicate).count
        }
    }

    private static let ids = [
        "aaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbb",
        "cccccccccccccccccccccccc",
    ]

    private func changesBody(rows: [(cursor: Int64, id: String, kind: String)]) -> String {
        let rowsJSON = rows.map {
            """
            {"cursor": \($0.cursor), "asset_id": "\($0.id)", "folder_id": "F1",
             "kind": "\($0.kind)", "abs_path": "/srv/lib/2026/\($0.id).dng", "at": "2026-05-16T00:00:00Z"}
            """
        }.joined(separator: ",")
        let next = rows.map(\.cursor).max() ?? 0
        return #"{"changes": [\#(rowsJSON)], "next_cursor": \#(next)}"#
    }

    private func metaJSON(_ id: String) -> String {
        """
        {"id": "\(id)", "folder_id": "F1", "filename": "\(id).dng",
         "abs_path": "/srv/lib/2026/\(id).dng", "size": 4096, "mtime": 1700000000000, "rating": 0}
        """
    }

    private func makeEnumerator(session: URLSession) -> WorkingSetEnumerator {
        let server = URL(string: "https://x.test")!
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let catalog = RemoteCatalog(http: http, server: server, downloadURLSession: session)
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cursor-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: tmpDir) }
        let rootCache = LibraryRootCache(
            domainID: "test-\(UUID().uuidString)",
            defaults: UserDefaults(suiteName: "test-\(UUID().uuidString)"),
            fetcher: { [LibraryRoot(id: "F1", path: "/srv/lib", label: "F1", fileCount: 0)] }
        )
        return WorkingSetEnumerator(
            catalog: catalog,
            workingSet: WorkingSet(capacity: 100),
            cursorStore: ChangeCursorStore(directory: tmpDir),
            domainID: "test-domain",
            listCache: WorkingSetListCache(catalog: catalog),
            rootCache: rootCache
        )
    }

    private func run(_ session: URLSession) async throws -> TestChangeObserver {
        let observer = TestChangeObserver()
        makeEnumerator(session: session)
            .enumerateChanges(for: observer,
                              from: NSFileProviderSyncAnchor(Data("0".utf8)))
        let finished = await observer.waitUntilFinished(timeoutSeconds: 5)
        XCTAssertTrue(finished, "enumerateChanges did not finish in time")
        return observer
    }

    func testBatchEndpointResolvesWholePageInOneRequest() async throws {
        let log = RequestLog()
        let session = URLSession.stubbedSequence { req in
            log.record(req)
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            if req.url!.path.contains("/api/changes") {
                let rows = Self.ids.enumerated().map { (Int64($0.offset + 1), $0.element, "update") }
                return (self.changesBody(rows: rows).data(using: .utf8)!, resp)
            }
            let assets = Self.ids.map { self.metaJSON($0) }.joined(separator: ",")
            return (#"{"assets": [\#(assets)]}"#.data(using: .utf8)!, resp)
        }

        let observer = try await run(session)

        XCTAssertNil(observer.error)
        XCTAssertEqual(observer.updates.count, 3)
        XCTAssertEqual(Set(observer.updates.compactMap { ($0 as? MapleItem)?.filename }),
                       Set(Self.ids.map { "\($0).dng" }))
        XCTAssertEqual(log.count { $0 == "POST /api/assets/batch-meta" }, 1,
                       "the whole page must resolve through one batch request")
        XCTAssertEqual(log.count { $0.hasPrefix("GET /api/assets/") }, 0,
                       "no per-asset GETs when the batch endpoint is available")
    }

    func testRepeatedRowsForOneAssetResolveOnce() async throws {
        let id = Self.ids[0]
        let log = RequestLog()
        let session = URLSession.stubbedSequence { req in
            log.record(req)
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            if req.url!.path.contains("/api/changes") {
                // The thumb/xmp/describe stages each emit a row for the same
                // asset — the exact duplication that amplified the storm.
                let rows = (1...4).map { (Int64($0), id, "update") }
                return (self.changesBody(rows: rows).data(using: .utf8)!, resp)
            }
            return (#"{"assets": [\#(self.metaJSON(id))]}"#.data(using: .utf8)!, resp)
        }

        let observer = try await run(session)

        XCTAssertNil(observer.error)
        XCTAssertEqual(observer.updates.count, 1)
        XCTAssertEqual(log.count { $0 == "POST /api/assets/batch-meta" }, 1)
        // The batch body must carry the id exactly once.
        let body = URLProtocolStub.capturedBodies.values
            .compactMap { String(data: $0, encoding: .utf8) }
            .first { $0.contains("ids") } ?? ""
        XCTAssertEqual(body.components(separatedBy: id).count - 1, 1,
                       "duplicate rows must dedupe to one id in the batch body")
    }

    func testBatchMissingIdReportedAsDelete() async throws {
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            if req.url!.path.contains("/api/changes") {
                let rows = [(Int64(1), Self.ids[0], "update"), (Int64(2), Self.ids[1], "update")]
                return (self.changesBody(rows: rows).data(using: .utf8)!, resp)
            }
            // Only the first id resolves; the second raced a server-side delete.
            return (#"{"assets": [\#(self.metaJSON(Self.ids[0]))]}"#.data(using: .utf8)!, resp)
        }

        let observer = try await run(session)

        XCTAssertNil(observer.error)
        XCTAssertEqual(observer.updates.count, 1)
        XCTAssertEqual(observer.deletes,
                       [NSFileProviderItemIdentifier(
                           FileProviderIdentifier.asset(Self.ids[1]).rawValue)])
    }

    func testDeleteRowsAreNotFetched() async throws {
        let log = RequestLog()
        let session = URLSession.stubbedSequence { req in
            log.record(req)
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            if req.url!.path.contains("/api/changes") {
                let rows = [(Int64(1), Self.ids[0], "delete")]
                return (self.changesBody(rows: rows).data(using: .utf8)!, resp)
            }
            return (#"{"assets": []}"#.data(using: .utf8)!, resp)
        }

        let observer = try await run(session)

        XCTAssertNil(observer.error)
        XCTAssertEqual(observer.deletes.count, 1)
        XCTAssertEqual(log.count { $0 == "POST /api/assets/batch-meta" }, 0,
                       "a page of pure deletes needs no metadata at all")
    }

    func testBatchHTTPErrorAbortsInsteadOfPerAssetFanOut() async throws {
        // Jules review on PR #3009: a 5xx (or 401/403) from the batch route
        // means the server is unhealthy — falling back to ~500 per-asset
        // GETs would amplify load exactly when it can least absorb it.
        // The batch must abort the call (no anchor advance, OS retries
        // later) and fire ZERO per-asset GETs.
        let log = RequestLog()
        let session = URLSession.stubbedSequence { req in
            log.record(req)
            if req.url!.path.hasSuffix("/batch-meta") {
                let resp = HTTPURLResponse(url: req.url!, statusCode: 500,
                                           httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
                return (#"{"error": "boom"}"#.data(using: .utf8)!, resp)
            }
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            if req.url!.path.contains("/api/changes") {
                let rows = [(Int64(1), Self.ids[0], "update"), (Int64(2), Self.ids[1], "update")]
                return (self.changesBody(rows: rows).data(using: .utf8)!, resp)
            }
            return (self.metaJSON(req.url!.lastPathComponent).data(using: .utf8)!, resp)
        }

        let observer = try await run(session)

        let error = try XCTUnwrap(observer.error as NSError?)
        XCTAssertEqual(error.domain, NSFileProviderErrorDomain)
        XCTAssertTrue(observer.updates.isEmpty)
        XCTAssertEqual(log.count { $0.hasPrefix("GET /api/assets/") }, 0,
                       "an unhealthy server must not receive the per-asset fan-out")
    }

    func testBatchDecodeFailureFallsBackToPerAssetGets() async throws {
        // A 200 with a garbled body (misbehaving proxy) is not a server-
        // health signal — the per-asset path is the right recovery there.
        let log = RequestLog()
        let session = URLSession.stubbedSequence { req in
            log.record(req)
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            if req.url!.path.hasSuffix("/batch-meta") {
                return ("not json".data(using: .utf8)!, resp)
            }
            if req.url!.path.contains("/api/changes") {
                let rows = [(Int64(1), Self.ids[0], "update")]
                return (self.changesBody(rows: rows).data(using: .utf8)!, resp)
            }
            return (self.metaJSON(req.url!.lastPathComponent).data(using: .utf8)!, resp)
        }

        let observer = try await run(session)

        XCTAssertNil(observer.error)
        XCTAssertEqual(observer.updates.count, 1)
        XCTAssertEqual(log.count { $0.hasPrefix("GET /api/assets/") }, 1)
    }

    func testFallsBackToPerAssetGetsWhenBatchUnsupported() async throws {
        let log = RequestLog()
        let session = URLSession.stubbedSequence { req in
            log.record(req)
            if req.url!.path.hasSuffix("/batch-meta") {
                // Old Self Hosted server: route doesn't exist.
                let resp = HTTPURLResponse(url: req.url!, statusCode: 404,
                                           httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
                return (#"{"error": "Not found"}"#.data(using: .utf8)!, resp)
            }
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            if req.url!.path.contains("/api/changes") {
                let rows = [(Int64(1), Self.ids[0], "update"), (Int64(2), Self.ids[1], "update")]
                return (self.changesBody(rows: rows).data(using: .utf8)!, resp)
            }
            // Legacy per-asset GET /api/assets/:id
            let id = req.url!.lastPathComponent
            return (self.metaJSON(id).data(using: .utf8)!, resp)
        }

        let observer = try await run(session)

        XCTAssertNil(observer.error)
        XCTAssertEqual(observer.updates.count, 2)
        XCTAssertEqual(log.count { $0.hasPrefix("GET /api/assets/") }, 2,
                       "old server: each asset resolves via the legacy per-asset GET")
    }
}
