// src/apple/Packages/MapleCore/Tests/MapleCoreTests/ChangeFeedClientServerMigrationTests.swift
//
// Regression tests for #2533: ChangeFeedClient's `server` was an immutable
// `let` with no update path, so the SSE change feed stayed pinned to the
// identity URL forever — unlike `RemoteCatalog`, which
// `FileProviderExtensionCore` re-points at the resolved LAN address via
// `updateServer(_:)` once `LocalNetworkResolving.resolveEffectiveURL`
// completes. For a LAN-only self-hosted server this could mean the change
// feed never connects at all.
//
// These tests exercise `subscribeRequest(since:)` — the pure request-
// building step factored out of `runOneConnection()` — rather than a live
// socket, mirroring how `ChangeFeedClientBackoffTests` unit-tests backoff
// policy without one. `runOneConnection()`'s actual byte stream goes
// through `URLSession.shared.bytes(for:)`, which isn't stubbable from a
// unit test, so the request-building seam is what's testable in isolation.

import XCTest
@testable import MapleCore

final class ChangeFeedClientServerMigrationTests: XCTestCase {
    private func freshCursorDirectory() -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("changefeed-servermig-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func makeClient(server: URL) -> ChangeFeedClient {
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let cursorStore = ChangeCursorStore(directory: freshCursorDirectory())
        return ChangeFeedClient(
            server: server,
            http: http,
            cursorStore: cursorStore,
            domainID: "test-domain",
            onEvent: { _ in }
        )
    }

    func testSubscribeRequestUsesIdentityServerBeforeMigration() {
        let identity = URL(string: "https://maple.example.com")!
        let client = makeClient(server: identity)
        let req = client.subscribeRequest(since: 7)
        XCTAssertEqual(req.url?.host, "maple.example.com")
        XCTAssertTrue(req.url?.path == "/api/changes/subscribe")
        XCTAssertTrue(req.url?.query?.contains("since=7") == true)
    }

    /// The core regression: after `updateServer(_:)` — the same call
    /// `FileProviderExtensionCore` makes on `RemoteCatalog` once LAN
    /// resolution completes — the NEXT subscribe request must go to the
    /// new (LAN) address, not stay pinned to identity.
    func testUpdateServerMigratesSubsequentSubscribeRequests() {
        let identity = URL(string: "https://maple.example.com")!
        let lan = URL(string: "http://192.168.1.50:8080")!
        let client = makeClient(server: identity)
        XCTAssertEqual(client.subscribeRequest(since: 0).url?.host, "maple.example.com")

        client.updateServer(lan)

        let migrated = client.subscribeRequest(since: 0)
        XCTAssertEqual(migrated.url?.host, "192.168.1.50")
        XCTAssertEqual(migrated.url?.port, 8080)
        XCTAssertEqual(migrated.url?.scheme, "http")
    }

    /// `updateServer` may race a concurrent reconnect building its own
    /// request off the old value — this drives that race a bounded number
    /// of times to catch a torn/crashed read of `server` under
    /// `ThreadSanitizer`, not to assert a specific interleaving outcome.
    func testUpdateServerIsThreadSafeUnderConcurrentReads() {
        let identity = URL(string: "https://maple.example.com")!
        let lan = URL(string: "http://192.168.1.50:8080")!
        let client = makeClient(server: identity)
        let iterations = 200
        DispatchQueue.concurrentPerform(iterations: iterations) { i in
            if i % 2 == 0 {
                client.updateServer(i % 4 == 0 ? lan : identity)
            } else {
                _ = client.subscribeRequest(since: Int64(i))
            }
        }
        // No crash / TSan violation is the assertion; sanity-check the
        // client is still in a usable state afterward.
        XCTAssertNotNil(client.subscribeRequest(since: 0).url)
    }
}
