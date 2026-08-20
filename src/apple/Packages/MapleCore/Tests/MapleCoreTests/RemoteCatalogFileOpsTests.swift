// src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogFileOpsTests.swift
//
// Covers `RemoteCatalog.deleteFile` / `.relocateFile` (#2535) — the
// path-addressed delete/move/rename client calls for non-asset
// (`.file`-identified) items. Uses `URLProtocolStub` — no network.

import FileProvider
import XCTest
@testable import MapleCore

final class RemoteCatalogFileOpsTests: XCTestCase {

    // MARK: - deleteFile

    func testDeleteFileSendsPathQueryAndReturnsOkOn204() async throws {
        let server = URL(string: "https://example.test")!
        let observed = RequestObserver()
        let session = URLSession.stubbedSequence { req in
            observed.record(path: req.url?.path, method: req.httpMethod,
                            query: req.url?.query)
            let resp = HTTPURLResponse(url: req.url!, statusCode: 204,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)

        let result = try await cat.deleteFile(folderID: "650a", relativePath: "docs/notes.pdf")
        XCTAssertEqual(result, .ok)
        let snap = observed.snapshot()
        XCTAssertEqual(snap.path, "/api/folders/650a/file")
        XCTAssertEqual(snap.method, "DELETE")
        XCTAssertEqual(snap.query, "path=docs/notes.pdf")
    }

    func testDeleteFileReturnsIndexedAssetOn409() async throws {
        let server = URL(string: "https://example.test")!
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 409,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(#"{"error":"path is an indexed asset","asset_id":"aaaaaaaaaaaaaaaaaaaaaaaa"}"#.utf8), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)

        let result = try await cat.deleteFile(folderID: "650a", relativePath: "photo.jpg")
        XCTAssertEqual(result, .indexedAsset(assetID: "aaaaaaaaaaaaaaaaaaaaaaaa"))
    }

    func testDeleteFileThrowsOn404() async throws {
        let server = URL(string: "https://example.test")!
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 404,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)

        do {
            _ = try await cat.deleteFile(folderID: "650a", relativePath: "gone.pdf")
            XCTFail("expected a thrown error on 404")
        } catch {
            let nsError = error as NSError
            XCTAssertEqual(nsError.domain, NSFileProviderErrorDomain)
            XCTAssertEqual(nsError.code, NSFileProviderError.noSuchItem.rawValue)
        }
    }

    // MARK: - relocateFile

    func testRelocateFileSendsJSONBodyAndDecodesRelocated() async throws {
        let server = URL(string: "https://example.test")!
        let observed = RequestObserver()
        let session = URLSession.stubbedSequence { req in
            observed.record(path: req.url?.path, method: req.httpMethod, query: nil)
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            let respBody = """
            {"new_abs_path": "/lib/archive/notes.pdf", "new_path": "archive",
             "new_filename": "notes.pdf", "renamed_on_collision": false}
            """
            return (Data(respBody.utf8), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)

        let result = try await cat.relocateFile(
            folderID: "650a",
            sourceRelativePath: "notes.pdf",
            mode: .move,
            collision: .fail,
            destinationRelativePath: "archive"
        )
        guard case .ok(let resp) = result else {
            return XCTFail("expected .ok, got \(result)")
        }
        XCTAssertEqual(resp.newAbsPath, "/lib/archive/notes.pdf")
        XCTAssertEqual(resp.newPath, "archive")
        XCTAssertEqual(resp.newFilename, "notes.pdf")
        XCTAssertFalse(resp.renamedOnCollision)

        let snap = observed.snapshot()
        XCTAssertEqual(snap.path, "/api/folders/650a/file/relocate")
        XCTAssertEqual(snap.method, "POST")

        // `URLProtocol` strips the body off the `URLRequest` before the
        // loader sees it — inspect the stub's captured-bodies dictionary
        // instead (same pattern `EditSessionTests` uses for its `putXMP`
        // body assertions).
        let bodyData = URLProtocolStub.capturedBodies["https://example.test/api/folders/650a/file/relocate"]
        let body = bodyData.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
        XCTAssertEqual(body?["source_path"] as? String, "notes.pdf")
        XCTAssertEqual(body?["mode"] as? String, "move")
        // `.fail` maps to the wire string "skip" — same vocabulary
        // `relocateAsset`'s `wireCollision` uses for the identical case.
        XCTAssertEqual(body?["collision"] as? String, "skip")
        XCTAssertEqual(body?["destination_path"] as? String, "archive")
    }

    func testRelocateFileReturnsSkippedWhenServerReportsCollision() async throws {
        let server = URL(string: "https://example.test")!
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            return (Data(#"{"skipped": true, "reason": "collision"}"#.utf8), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)

        let result = try await cat.relocateFile(
            folderID: "650a",
            sourceRelativePath: "notes.pdf",
            mode: .move,
            collision: .fail,
            destinationRelativePath: "",
            destinationFilename: "existing.pdf"
        )
        XCTAssertEqual(result, .skipped(reason: "collision"))
    }

    func testRelocateFileReturnsIndexedAssetOn409() async throws {
        let server = URL(string: "https://example.test")!
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 409,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(#"{"error":"path is an indexed asset","asset_id":"bbbbbbbbbbbbbbbbbbbbbbbb"}"#.utf8), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)

        let result = try await cat.relocateFile(
            folderID: "650a",
            sourceRelativePath: "photo.jpg",
            mode: .move,
            collision: .fail,
            destinationRelativePath: ""
        )
        XCTAssertEqual(result, .indexedAsset(assetID: "bbbbbbbbbbbbbbbbbbbbbbbb"))
    }
}

private final class RequestObserver: @unchecked Sendable {
    struct Snapshot {
        var path: String?
        var method: String?
        var query: String?
        var body: [String: Any]?
    }
    private let lock = NSLock()
    private var snap = Snapshot()
    func record(path: String?, method: String?, query: String?, body: [String: Any]? = nil) {
        lock.lock(); defer { lock.unlock() }
        snap = Snapshot(path: path, method: method, query: query, body: body)
    }
    func snapshot() -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        return snap
    }
}
