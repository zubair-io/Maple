// src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogETagTests.swift
import XCTest
@testable import MapleCore

/// Verifies the per-URL ETag cache inside `RemoteCatalog`:
///   • first call sends no `If-None-Match`, stores the returned ETag
///   • subsequent calls echo the cached ETag back in `If-None-Match`
///   • on 304, the decoded payload is reused from the cache
///   • on 200 with a new ETag, the cache is replaced
///
/// Uses `URLProtocolStub` (shared test helper) — no real network.
final class RemoteCatalogETagTests: XCTestCase {

    // MARK: - listFolders

    func testListFoldersSendsIfNoneMatchOnSecondCall() async throws {
        let server = URL(string: "https://example.test")!
        let observed = HeaderObserver()
        let body = #"[{"id":"650a","path":"/p","label":"p","file_count":1}]"#
        let session = URLSession.stubbedSequence { req in
            observed.record(req.value(forHTTPHeaderField: "If-None-Match"))
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["ETag": "\"abc\""])!
            return (body.data(using: .utf8)!, resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)
        _ = try await cat.listFolders()
        _ = try await cat.listFolders()
        let seen = observed.snapshot()
        XCTAssertEqual(seen.count, 2)
        XCTAssertNil(seen[0])
        XCTAssertEqual(seen[1], "\"abc\"")
    }

    func testListFolders304ReturnsCachedValue() async throws {
        let server = URL(string: "https://example.test")!
        let calls = CallCounter()
        let session = URLSession.stubbedSequence { req in
            let n = calls.bump()
            if n == 1 {
                let body = #"[{"id":"650a","path":"/p","label":"p","file_count":1}]"#
                let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                           httpVersion: "HTTP/1.1",
                                           headerFields: ["ETag": "\"abc\""])!
                return (body.data(using: .utf8)!, resp)
            } else {
                let resp = HTTPURLResponse(url: req.url!, statusCode: 304,
                                           httpVersion: "HTTP/1.1",
                                           headerFields: ["ETag": "\"abc\""])!
                return (Data(), resp)
            }
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)
        let first = try await cat.listFolders()
        let second = try await cat.listFolders()
        XCTAssertEqual(first, second)
        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(first[0].id, "650a")
    }

    func testListFoldersNewETagReplacesCache() async throws {
        let server = URL(string: "https://example.test")!
        let calls = CallCounter()
        let session = URLSession.stubbedSequence { req in
            let n = calls.bump()
            let etag = n == 1 ? "\"abc\"" : "\"def\""
            let body = n == 1
                ? #"[{"id":"a","path":"/a","label":"a","file_count":1}]"#
                : #"[{"id":"a","path":"/a","label":"a","file_count":2}]"#
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["ETag": etag])!
            return (body.data(using: .utf8)!, resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)
        let first = try await cat.listFolders()
        let second = try await cat.listFolders()
        XCTAssertEqual(first[0].fileCount, 1)
        XCTAssertEqual(second[0].fileCount, 2)
    }

    // MARK: - listDir

    func testListDirRoundTripsETag() async throws {
        let server = URL(string: "https://example.test")!
        let observed = HeaderObserver()
        let calls = CallCounter()
        let body = #"""
        {"path":"/p","parent":null,"dirs":[],"images":[],"sidecars":[]}
        """#
        let session = URLSession.stubbedSequence { req in
            observed.record(req.value(forHTTPHeaderField: "If-None-Match"))
            let n = calls.bump()
            if n == 1 {
                let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                           httpVersion: "HTTP/1.1",
                                           headerFields: ["ETag": "\"xyz\""])!
                return (body.data(using: .utf8)!, resp)
            } else {
                let resp = HTTPURLResponse(url: req.url!, statusCode: 304,
                                           httpVersion: "HTTP/1.1",
                                           headerFields: ["ETag": "\"xyz\""])!
                return (Data(), resp)
            }
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)
        let first = try await cat.listDir(absolutePath: "/p")
        let second = try await cat.listDir(absolutePath: "/p")
        XCTAssertEqual(first, second)
        let seen = observed.snapshot()
        XCTAssertNil(seen[0])
        XCTAssertEqual(seen[1], "\"xyz\"")
    }

    // MARK: - getThumb

    func testGetThumb304ReturnsCachedBytes() async throws {
        let server = URL(string: "https://example.test")!
        let observed = HeaderObserver()
        let calls = CallCounter()
        let jpegBytes = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
        let session = URLSession.stubbedSequence { req in
            observed.record(req.value(forHTTPHeaderField: "If-None-Match"))
            let n = calls.bump()
            if n == 1 {
                let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                           httpVersion: "HTTP/1.1",
                                           headerFields: ["ETag": "\"t1\"",
                                                          "Content-Type": "image/jpeg"])!
                return (jpegBytes, resp)
            } else {
                let resp = HTTPURLResponse(url: req.url!, statusCode: 304,
                                           httpVersion: "HTTP/1.1",
                                           headerFields: ["ETag": "\"t1\""])!
                return (Data(), resp)
            }
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)
        let first = try await cat.getThumb(assetID: "650a000000000000000000aa")
        let second = try await cat.getThumb(assetID: "650a000000000000000000aa")
        XCTAssertEqual(first, jpegBytes)
        XCTAssertEqual(second, jpegBytes)
        let seen = observed.snapshot()
        XCTAssertNil(seen[0])
        XCTAssertEqual(seen[1], "\"t1\"")
    }

    func testInvalidateETagCacheForcesFreshFetch() async throws {
        let server = URL(string: "https://example.test")!
        let observed = HeaderObserver()
        let body = #"[{"id":"a","path":"/a","label":"a","file_count":1}]"#
        let session = URLSession.stubbedSequence { req in
            observed.record(req.value(forHTTPHeaderField: "If-None-Match"))
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["ETag": "\"abc\""])!
            return (body.data(using: .utf8)!, resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)
        _ = try await cat.listFolders()
        await cat.invalidateETagCache()
        _ = try await cat.listFolders()
        let seen = observed.snapshot()
        XCTAssertEqual(seen.count, 2)
        XCTAssertNil(seen[0])
        // After invalidate, second call must NOT echo the prior ETag.
        XCTAssertNil(seen[1])
    }
}

// MARK: - Test helpers

/// Sendable wrapper around an array of observed If-None-Match values.
/// `URLProtocolStub.responseProvider` is @Sendable so the closure body
/// must avoid capturing mutable locals; this NSLock-backed reference
/// type gives us thread-safe `record` / `snapshot` without using
/// `nonisolated(unsafe)`.
private final class HeaderObserver: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String?] = []
    func record(_ v: String?) {
        lock.lock(); defer { lock.unlock() }
        values.append(v)
    }
    func snapshot() -> [String?] {
        lock.lock(); defer { lock.unlock() }
        return values
    }
}

private final class CallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func bump() -> Int {
        lock.lock(); defer { lock.unlock() }
        n += 1
        return n
    }
}
