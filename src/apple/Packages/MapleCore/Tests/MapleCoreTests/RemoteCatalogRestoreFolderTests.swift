// src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogRestoreFolderTests.swift
import XCTest
@testable import MapleCore

/// Covers `RemoteCatalog.restoreFolder` (#2751) — the client half of
/// folder-level Cloud trash restore (`POST /api/folders/<id>/restore-folder`).
/// Uses `URLProtocolStub` — no network, same harness
/// `RemoteCatalogMoveFolderTests`/`trashFolder`'s sibling shape uses.
final class RemoteCatalogRestoreFolderTests: XCTestCase {

    func testRestoreFolderSendsTargetHeaderAndDecodesSummary() async throws {
        let server = URL(string: "https://example.test")!
        let observed = RestoreFolderRequestObserver()
        let session = URLSession.stubbedSequence { req in
            observed.record(
                path: req.url?.path,
                method: req.httpMethod,
                target: req.value(forHTTPHeaderField: "X-Maple-Target-Path"))
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            let body = """
            {"total":2,"succeeded":2,"failed":0,"items":[
              {"assetId":"a1","filename":"IMG_1.dng","ok":true},
              {"assetId":"a2","filename":"IMG_2.dng","ok":true}
            ]}
            """
            return (Data(body.utf8), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)

        let summary = try await cat.restoreFolder(folderID: "650a", relativePath: "2024/Paris")

        XCTAssertEqual(summary.total, 2)
        XCTAssertEqual(summary.succeeded, 2)
        XCTAssertEqual(summary.failed, 0)
        XCTAssertEqual(summary.items.map(\.assetId), ["a1", "a2"])
        let snap = observed.snapshot()
        XCTAssertEqual(snap.path, "/api/folders/650a/restore-folder")
        XCTAssertEqual(snap.method, "POST")
        // Header is percent-encoded by `encodeTargetPath`; the slash in
        // "2024/Paris" must survive the round-trip.
        XCTAssertEqual(snap.target?.removingPercentEncoding, "2024/Paris")
    }

    func testRestoreFolderDecodesAPartialFailure() async throws {
        let server = URL(string: "https://example.test")!
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            let body = """
            {"total":2,"succeeded":1,"failed":1,"items":[
              {"assetId":"a1","filename":"IMG_1.dng","ok":true},
              {"assetId":"a2","filename":"IMG_2.dng","ok":false,"error":"destination exists"}
            ]}
            """
            return (Data(body.utf8), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)

        let summary = try await cat.restoreFolder(folderID: "650a", relativePath: "2024/Paris")

        XCTAssertEqual(summary.succeeded, 1)
        XCTAssertEqual(summary.failed, 1)
        XCTAssertEqual(summary.items.last?.error, "destination exists")
    }

    func testRestoreFolderThrowsOnServerError() async throws {
        let server = URL(string: "https://example.test")!
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 500,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(#"{"error":"restore failed"}"#.utf8), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)

        do {
            _ = try await cat.restoreFolder(folderID: "650a", relativePath: "2024/Paris")
            XCTFail("expected a thrown error on 500")
        } catch {
            // expected
        }
    }
}

private final class RestoreFolderRequestObserver: @unchecked Sendable {
    struct Snapshot { var path: String?; var method: String?; var target: String? }
    private let lock = NSLock()
    private var snap = Snapshot()
    func record(path: String?, method: String?, target: String?) {
        lock.lock(); defer { lock.unlock() }
        snap = Snapshot(path: path, method: method, target: target)
    }
    func snapshot() -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        return snap
    }
}
