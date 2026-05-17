// src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogChangesTests.swift
import XCTest
@testable import MapleCore

final class RemoteCatalogChangesTests: XCTestCase {

    // MARK: - listChanges

    func testListChangesHappyPath() async throws {
        let server = URL(string: "https://example.test")!
        var observedQuery: String?
        let body = #"""
        {"changes": [
          {"cursor": 43, "asset_id": "650a", "folder_id": "650b",
           "kind": "update", "abs_path": "/p/a.dng", "at": "2026-05-16T00:00:00Z"}
        ], "next_cursor": 43}
        """#
        let session = URLSession.stubbedSequence { req in
            observedQuery = req.url?.query
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            return (body.data(using: .utf8)!, resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let catalog = RemoteCatalog(http: http, server: server)
        let page = try await catalog.listChanges(since: 42)
        XCTAssertTrue(observedQuery?.contains("since=42") == true)
        XCTAssertEqual(page.changes.count, 1)
        XCTAssertEqual(page.nextCursor, 43)
        XCTAssertEqual(page.changes[0].kind, .update)
        XCTAssertEqual(page.changes[0].cursor, 43)
        XCTAssertEqual(page.changes[0].assetID, "650a")
    }

    func testListChangesStaleCursorThrowsStaleCursorError() async {
        let server = URL(string: "https://example.test")!
        let body = #"{"error": "cursor too old", "current": 999}"#
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 409,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: nil)!
            return (body.data(using: .utf8)!, resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let catalog = RemoteCatalog(http: http, server: server)
        do {
            _ = try await catalog.listChanges(since: 1)
            XCTFail("expected StaleCursorError")
        } catch let e as StaleCursorError {
            XCTAssertEqual(e.current, 999)
        } catch {
            XCTFail("wrong error type: \(error)")
        }
    }

    // MARK: - listAssets

    func testListAssetsBuildsQuery() async throws {
        let server = URL(string: "https://example.test")!
        var observedQuery: String?
        let session = URLSession.stubbedSequence { req in
            observedQuery = req.url?.query ?? ""
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            return (#"{"assets": []}"#.data(using: .utf8)!, resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let catalog = RemoteCatalog(http: http, server: server)
        let res = try await catalog.listAssets(hasXMP: true, ratingGTE: 1,
                                                capturedAfter: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(res.assets.count, 0)
        let q = observedQuery ?? ""
        XCTAssertTrue(q.contains("has_xmp=1"), "query was \(q)")
        XCTAssertTrue(q.contains("rating_gte=1"), "query was \(q)")
        XCTAssertTrue(q.contains("captured_after="), "query was \(q)")
        XCTAssertTrue(q.contains("limit=1000"), "query was \(q)")
    }

    func testListAssetsParsesEntries() async throws {
        let server = URL(string: "https://example.test")!
        let body = #"""
        {"assets": [
          {"id": "650a", "folder_id": "650b", "filename": "a.dng",
           "abs_path": "/p/a.dng", "mtime": 1700000000, "rating": 5,
           "has_xmp": true}
        ]}
        """#
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: nil)!
            return (body.data(using: .utf8)!, resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let catalog = RemoteCatalog(http: http, server: server)
        let res = try await catalog.listAssets()
        XCTAssertEqual(res.assets.count, 1)
        XCTAssertEqual(res.assets[0].filename, "a.dng")
        XCTAssertEqual(res.assets[0].rating, 5)
        XCTAssertTrue(res.assets[0].hasXMP)
    }
}
