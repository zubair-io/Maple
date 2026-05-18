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

    // MARK: - LRU bound (Phase 6 item 1)

    /// Inserting `cap + 1` distinct entries evicts the oldest. The
    /// oldest URL, on re-fetch, must NOT echo a prior ETag — its entry
    /// is gone — while the most-recently inserted URLs still do.
    func testLRUEvictsOldestWhenCapExceeded() async throws {
        let server = URL(string: "https://example.test")!
        let observed = HeaderObserver()
        let cap = RemoteCatalog.etagCacheCap
        let session = URLSession.stubbedSequence { req in
            observed.record(req.url!.absoluteString +
                            " | " + (req.value(forHTTPHeaderField: "If-None-Match") ?? "nil"))
            // Each dir URL gets a stable ETag derived from its path.
            let path = req.url!.path + (req.url!.query.map { "?\($0)" } ?? "")
            let etag = "\"\(abs(path.hashValue))\""
            let body = #"{"path":"/p","parent":null,"dirs":[],"images":[],"sidecars":[]}"#
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["ETag": etag])!
            return (body.data(using: .utf8)!, resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)
        // Insert cap + 1 distinct entries.
        for i in 0..<(cap + 1) {
            _ = try await cat.listDir(absolutePath: "/dir/\(i)")
        }
        // Re-fetch the very first entry — its cache slot must be evicted.
        _ = try await cat.listDir(absolutePath: "/dir/0")
        // Re-fetch the most-recent — its cache slot must still be live.
        _ = try await cat.listDir(absolutePath: "/dir/\(cap)")
        let seen = observed.snapshot()
        // Last two records are the re-fetches.
        let reFetchFirst = seen[seen.count - 2]
        let reFetchLast = seen[seen.count - 1]
        XCTAssertTrue(reFetchFirst?.hasSuffix(" | nil") ?? false,
                      "evicted entry should not echo a prior ETag; got \(reFetchFirst)")
        XCTAssertFalse(reFetchLast?.hasSuffix(" | nil") ?? false,
                       "MRU entry should still send If-None-Match; got \(reFetchLast)")
    }

    /// Reading an existing entry promotes it to MRU. After the touch,
    /// inserting a new entry should evict whatever became the new LRU
    /// (not the touched entry).
    func testReadingEntryPromotesToMRU() async throws {
        let server = URL(string: "https://example.test")!
        let observed = HeaderObserver()
        let cap = RemoteCatalog.etagCacheCap
        let session = URLSession.stubbedSequence { req in
            observed.record(req.url!.path +
                            " | " + (req.value(forHTTPHeaderField: "If-None-Match") ?? "nil"))
            let path = req.url!.path
            let etag = "\"\(abs(path.hashValue))\""
            let body = #"{"path":"/p","parent":null,"dirs":[],"images":[],"sidecars":[]}"#
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["ETag": etag])!
            return (body.data(using: .utf8)!, resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)
        // Fill the cache.
        for i in 0..<cap {
            _ = try await cat.listDir(absolutePath: "/dir/\(i)")
        }
        // Touch /dir/0 — this should promote it to MRU and demote /dir/1
        // to LRU (the cap doesn't change because the key already exists).
        _ = try await cat.listDir(absolutePath: "/dir/0")
        // Insert a brand-new entry — should evict /dir/1 (now LRU), not /dir/0.
        _ = try await cat.listDir(absolutePath: "/dir/new")
        // Re-fetch /dir/0 — must still have its entry (echo If-None-Match).
        _ = try await cat.listDir(absolutePath: "/dir/0")
        // Re-fetch /dir/1 — must be evicted (no If-None-Match).
        _ = try await cat.listDir(absolutePath: "/dir/1")
        let seen = observed.snapshot()
        let reFetchZero = seen[seen.count - 2]
        let reFetchOne = seen[seen.count - 1]
        XCTAssertFalse(reFetchZero?.hasSuffix(" | nil") ?? false,
                       "/dir/0 was touched then refetched — should still be cached; got \(reFetchZero)")
        XCTAssertTrue(reFetchOne?.hasSuffix(" | nil") ?? false,
                      "/dir/1 should have been evicted as new LRU; got \(reFetchOne)")
    }

    /// Re-inserting an existing key (same URL, new ETag from a 200
    /// response) refreshes the entry in place and does not evict any
    /// other entry. After the refresh, all cap entries are still cached.
    func testReinsertingExistingKeyDoesNotEvict() async throws {
        let server = URL(string: "https://example.test")!
        let observed = HeaderObserver()
        let cap = RemoteCatalog.etagCacheCap
        let counters = PathCallCounter()
        let session = URLSession.stubbedSequence { req in
            observed.record(req.url!.path +
                            " | " + (req.value(forHTTPHeaderField: "If-None-Match") ?? "nil"))
            let path = req.url!.path + (req.url!.query.map { "?\($0)" } ?? "")
            let n = counters.bump(path)
            // /dir/0 returns a fresh ETag on its second hit (forcing a
            // 200 replace, not a 304). Everything else is stable.
            let etag = (path.contains("path=/dir/0") && n >= 2)
                ? "\"v2\""
                : "\"\(abs(path.hashValue))\""
            let body = #"{"path":"/p","parent":null,"dirs":[],"images":[],"sidecars":[]}"#
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["ETag": etag])!
            return (body.data(using: .utf8)!, resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)
        for i in 0..<cap {
            _ = try await cat.listDir(absolutePath: "/dir/\(i)")
        }
        // Re-insert /dir/0 — the stub serves a fresh "v2" ETag so this
        // takes the 200 + replace branch, not 304.
        _ = try await cat.listDir(absolutePath: "/dir/0")
        // Verify every original entry is still cached: each re-fetch
        // must echo its (possibly updated) ETag, not nil.
        for i in 0..<cap {
            _ = try await cat.listDir(absolutePath: "/dir/\(i)")
        }
        let seen = observed.snapshot()
        // Last `cap` records are the verification round; none should be nil.
        let verifyRound = Array(seen.suffix(cap))
        for record in verifyRound {
            XCTAssertFalse(record?.hasSuffix(" | nil") ?? false,
                           "re-insert of existing key must not evict anything; got \(record)")
        }
    }

    /// `invalidateETagCache()` empties the cache regardless of how full
    /// it is. After invalidate, every URL re-fetch must send no
    /// If-None-Match.
    func testInvalidateClearsCacheRegardlessOfState() async throws {
        let server = URL(string: "https://example.test")!
        let observed = HeaderObserver()
        let cap = RemoteCatalog.etagCacheCap
        let session = URLSession.stubbedSequence { req in
            observed.record(req.url!.path +
                            " | " + (req.value(forHTTPHeaderField: "If-None-Match") ?? "nil"))
            let path = req.url!.path
            let etag = "\"\(abs(path.hashValue))\""
            let body = #"{"path":"/p","parent":null,"dirs":[],"images":[],"sidecars":[]}"#
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["ETag": etag])!
            return (body.data(using: .utf8)!, resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)
        for i in 0..<cap {
            _ = try await cat.listDir(absolutePath: "/dir/\(i)")
        }
        await cat.invalidateETagCache()
        for i in 0..<cap {
            _ = try await cat.listDir(absolutePath: "/dir/\(i)")
        }
        let seen = observed.snapshot()
        // Re-fetch round (last `cap` records) must all be nil — cache was wiped.
        let postInvalidate = Array(seen.suffix(cap))
        for record in postInvalidate {
            XCTAssertTrue(record?.hasSuffix(" | nil") ?? false,
                          "after invalidate every URL must miss the cache; got \(record)")
        }
    }

    /// Spacebar-walk simulation: insert N >> cap distinct entries and
    /// confirm the cache never grew beyond the cap. Uses the
    /// internal-only count accessor.
    func testCacheSizeStaysBoundedUnderHeavyLoad() async throws {
        let server = URL(string: "https://example.test")!
        let cap = RemoteCatalog.etagCacheCap
        let session = URLSession.stubbedSequence { req in
            let path = req.url!.path
            let etag = "\"\(abs(path.hashValue))\""
            let body = #"{"path":"/p","parent":null,"dirs":[],"images":[],"sidecars":[]}"#
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["ETag": etag])!
            return (body.data(using: .utf8)!, resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server,
                                                            urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)
        let total = cap * 4   // well past the cap
        for i in 0..<total {
            _ = try await cat.listDir(absolutePath: "/walk/\(i)")
        }
        let size = await cat._etagCacheCountForTesting
        XCTAssertEqual(size, cap, "cache must be bounded at cap, got \(size)")
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

/// Per-key call counter for tests that need separate sequences per URL.
private final class PathCallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]
    func bump(_ key: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        let next = (counts[key] ?? 0) + 1
        counts[key] = next
        return next
    }
}
