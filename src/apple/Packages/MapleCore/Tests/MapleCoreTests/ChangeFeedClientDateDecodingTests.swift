// src/apple/Packages/MapleCore/Tests/MapleCoreTests/ChangeFeedClientDateDecodingTests.swift
//
// Regression tests for #2534: ChangeFeedClient.decodeEvent used a plain
// `.iso8601` JSONDecoder date strategy, which does not parse fractional
// seconds. The server's `Date.toISOString()` (src/api/src/routes/changes.ts)
// always emits fractional seconds, so every real SSE event would fail to
// decode — silently, via `try?` — and the cursor would never advance.
//
// `RemoteCatalog` hit and fixed this exact problem; `ChangeFeedClient` must
// share the same fractional-seconds-then-plain decode strategy.

import XCTest
@testable import MapleCore

final class ChangeFeedClientDateDecodingTests: XCTestCase {
    private func freshCursorDirectory() -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("changefeed-datedecode-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func makeClient() -> ChangeFeedClient {
        let server = URL(string: "https://example.test")!
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

    /// The exact wire shape the server emits: `at` carries milliseconds,
    /// exactly what JS `Date.toISOString()` always produces. This is the
    /// core repro — with the old `.iso8601`-only strategy this decode
    /// silently returns nil.
    func testDecodesEventWithFractionalSecondTimestamp() {
        let client = makeClient()
        let payload = #"""
        {"cursor": 43, "asset_id": "650a", "folder_id": "650b",
         "kind": "update", "abs_path": "/p/a.dng", "at": "2026-05-15T10:00:00.123Z"}
        """#
        let event = client.decodeEvent(payload)
        XCTAssertNotNil(event, "fractional-second timestamps must decode, not be silently dropped")
        XCTAssertEqual(event?.cursor, 43)
        XCTAssertEqual(event?.kind, .update)
        let expected = ISO8601DateFormatter().date(from: "2026-05-15T10:00:00Z")!
        // Compare within 1s — the plain formatter used to build `expected`
        // truncates the fractional part.
        XCTAssertEqual(event!.at.timeIntervalSince1970,
                       expected.timeIntervalSince1970, accuracy: 1.0)
    }

    /// Whole-second timestamps (no fractional part) must keep working —
    /// this is what `.iso8601` alone already handled, and the fix must not
    /// regress it.
    func testDecodesEventWithPlainTimestamp() {
        let client = makeClient()
        let payload = #"""
        {"cursor": 44, "asset_id": "650a", "folder_id": "650b",
         "kind": "create", "abs_path": "/p/b.dng", "at": "2026-05-15T10:00:00Z"}
        """#
        let event = client.decodeEvent(payload)
        XCTAssertNotNil(event, "plain (non-fractional) ISO-8601 timestamps must still decode")
        XCTAssertEqual(event?.cursor, 44)
    }

    /// Malformed dates must still fail closed (nil), not crash or silently
    /// substitute some default date.
    func testRejectsGarbageTimestamp() {
        let client = makeClient()
        let payload = #"""
        {"cursor": 45, "asset_id": null, "folder_id": null,
         "kind": "delete", "abs_path": null, "at": "not-a-date"}
        """#
        XCTAssertNil(client.decodeEvent(payload))
    }
}
