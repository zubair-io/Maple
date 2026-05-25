// src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogMoveFolderTests.swift
import XCTest
@testable import MapleCore

/// Covers `RemoteCatalog.moveFolder`, the client half of folder
/// rename/move (Finder `modifyItem` on a `.folder` identifier ->
/// `POST /api/folders/<id>/move`). Uses `URLProtocolStub` — no network.
final class RemoteCatalogMoveFolderTests: XCTestCase {

    func testMoveFolderSendsSourceAndTargetHeadersAndDecodesAbsPath() async throws {
        let server = URL(string: "https://example.test")!
        let observed = MoveRequestObserver()
        let session = URLSession.stubbedSequence { req in
            observed.record(
                path: req.url?.path,
                method: req.httpMethod,
                source: req.value(forHTTPHeaderField: "X-Maple-Source-Path"),
                target: req.value(forHTTPHeaderField: "X-Maple-Target-Path"))
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            return (Data(#"{"abs_path":"/lib/0002"}"#.utf8), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)

        let result = try await cat.moveFolder(
            folderID: "650a",
            sourceRelativePath: "untitled folder",
            targetRelativePath: "0002")

        guard case .ok(let resp) = result else {
            return XCTFail("expected .ok, got \(result)")
        }
        XCTAssertEqual(resp.absPath, "/lib/0002")
        let snap = observed.snapshot()
        XCTAssertEqual(snap.path, "/api/folders/650a/move")
        XCTAssertEqual(snap.method, "POST")
        // Headers are percent-encoded by `encodeTargetPath`; the space in
        // "untitled folder" must survive the round-trip.
        XCTAssertEqual(snap.source?.removingPercentEncoding, "untitled folder")
        XCTAssertEqual(snap.target?.removingPercentEncoding, "0002")
    }

    func testMoveFolderReturnsConflictOn409() async throws {
        let server = URL(string: "https://example.test")!
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 409,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(#"{"error":"Target already exists"}"#.utf8), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)

        let result = try await cat.moveFolder(folderID: "650a",
                                              sourceRelativePath: "a",
                                              targetRelativePath: "b")
        XCTAssertEqual(result, .conflict)
    }

    func testMoveFolderThrowsOnServerError() async throws {
        let server = URL(string: "https://example.test")!
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 500,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(#"{"error":"move failed"}"#.utf8), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)

        do {
            _ = try await cat.moveFolder(folderID: "650a",
                                         sourceRelativePath: "a",
                                         targetRelativePath: "b")
            XCTFail("expected a thrown error on 500")
        } catch {
            // expected
        }
    }
}

private final class MoveRequestObserver: @unchecked Sendable {
    struct Snapshot { var path: String?; var method: String?; var source: String?; var target: String? }
    private let lock = NSLock()
    private var snap = Snapshot()
    func record(path: String?, method: String?, source: String?, target: String?) {
        lock.lock(); defer { lock.unlock() }
        snap = Snapshot(path: path, method: method, source: source, target: target)
    }
    func snapshot() -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        return snap
    }
}
