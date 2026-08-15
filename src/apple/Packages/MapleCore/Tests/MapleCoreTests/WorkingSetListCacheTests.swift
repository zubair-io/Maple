// src/apple/Packages/MapleCore/Tests/MapleCoreTests/WorkingSetListCacheTests.swift
//
// Coverage for #2545: WorkingSetListCache.entries() previously had no
// time-based fallback — only WorkingSetEnumerator's 50-event counter
// ever called `invalidate()`. A long-lived extension process that
// stays under that threshold could serve a stale asset list to
// Finder's working-set view indefinitely. These tests drive the cache
// directly (bypassing the enumerator's event counter entirely) against
// a call-counting stubbed `RemoteCatalog` and assert that entries()
// refetches once its own TTL has elapsed, using an injectable clock so
// the test doesn't depend on wall-clock sleeps.

import XCTest
@testable import MapleCore

final class WorkingSetListCacheTests: XCTestCase {
    /// Each uncached `entries()` call fans out to three `/api/assets`
    /// list queries (favourites + xmp + recent) — see
    /// `WorkingSetListCache.entries()`. Counting HTTP requests instead
    /// of asserting call-count directly on the actor keeps this test
    /// decoupled from that fan-out's internal shape.
    private actor RequestCounter {
        private(set) var count = 0
        func increment() { count += 1 }
    }

    private func makeCatalog(counter: RequestCounter) -> RemoteCatalog {
        let session = URLSession.stubbedSequence(
            onRequestStart: { await counter.increment() }
        ) { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
            return (Data(#"{"assets": []}"#.utf8), resp)
        }
        let server = URL(string: "https://x.test")!
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        return RemoteCatalog(http: http, server: server, downloadURLSession: session)
    }

    /// Back-to-back `entries()` calls within the TTL window must not
    /// refetch — this is the existing in-memory-cache behaviour and
    /// must not regress when the TTL fallback is added.
    func testEntriesAreCachedWithinTTL() async throws {
        let counter = RequestCounter()
        let catalog = makeCatalog(counter: counter)
        let cache = WorkingSetListCache(catalog: catalog, ttl: 300, now: { Date(timeIntervalSince1970: 1000) })

        _ = try await cache.entries()
        _ = try await cache.entries()
        _ = try await cache.entries()

        let requests = await counter.count
        XCTAssertEqual(requests, 3, "three list queries for the first fetch, zero more from the cached reads")
    }

    /// The core regression case for #2545: with no event-count
    /// invalidation ever firing (the enumerator's counter is not
    /// involved at all here — this test talks to the cache directly),
    /// entries() must still refetch once wall-clock time exceeds the
    /// cache's own TTL.
    func testEntriesRefetchAfterTTLElapsesWithNoExplicitInvalidate() async throws {
        let counter = RequestCounter()
        let catalog = makeCatalog(counter: counter)
        var now = Date(timeIntervalSince1970: 1000)
        let cache = WorkingSetListCache(catalog: catalog, ttl: 300, now: { now })

        _ = try await cache.entries()
        let afterFirst = await counter.count
        XCTAssertEqual(afterFirst, 3, "first fetch fans out to three list queries")

        // Still within TTL — must stay cached.
        now = now.addingTimeInterval(299)
        _ = try await cache.entries()
        let stillCached = await counter.count
        XCTAssertEqual(stillCached, 3, "within TTL: no refetch")

        // Past TTL — must refetch even though nothing ever called invalidate().
        now = now.addingTimeInterval(2)
        _ = try await cache.entries()
        let afterTTL = await counter.count
        XCTAssertEqual(afterTTL, 6, "past TTL: cache must self-invalidate and refetch")
    }

    /// Explicit `invalidate()` must keep working alongside the TTL
    /// fallback (the event-count path in `WorkingSetEnumerator` still
    /// calls this directly).
    func testExplicitInvalidateStillForcesRefetch() async throws {
        let counter = RequestCounter()
        let catalog = makeCatalog(counter: counter)
        let now = Date(timeIntervalSince1970: 1000)
        let cache = WorkingSetListCache(catalog: catalog, ttl: 300, now: { now })

        _ = try await cache.entries()
        await cache.invalidate()
        _ = try await cache.entries()

        let requests = await counter.count
        XCTAssertEqual(requests, 6, "invalidate() forces a refetch regardless of TTL")
    }
}
