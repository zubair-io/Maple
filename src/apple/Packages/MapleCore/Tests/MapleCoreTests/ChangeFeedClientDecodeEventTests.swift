// src/apple/Packages/MapleCore/Tests/MapleCoreTests/ChangeFeedClientDecodeEventTests.swift
import XCTest
@testable import MapleCore

/// Covers `ChangeFeedClient.decodeEvent(_:)`'s date parsing (Apple audit
/// #2534). The server's `Date.toISOString()` (`src/api/src/routes/changes.ts`)
/// always emits fractional seconds (`"2026-05-15T10:00:00.123Z"`).
/// `RemoteCatalog` needed a custom fractional-seconds-then-plain decoder
/// because plain `.iso8601` doesn't reliably parse that on every Foundation
/// version this app supports — `ChangeFeedClient` never got that fix and
/// decoded every SSE event with plain `.iso8601`. A decode failure here is
/// swallowed (`decodeEvent` returns nil) and the event is silently dropped
/// with no cursor advance — real-time sync goes dead with no error surfaced
/// anywhere.
final class ChangeFeedClientDecodeEventTests: XCTestCase {

    private func makeClient(tmpDir: URL) -> ChangeFeedClient {
        let server = URL(string: "https://example.test")!
        let http = AuthenticatedHTTPClient.unauthenticated(
            server: server, urlSession: URLSession.stubbedSequence { req in
                let resp = HTTPURLResponse(url: req.url!, statusCode: 200,
                                           httpVersion: "HTTP/1.1", headerFields: nil)!
                return (Data(), resp)
            })
        return ChangeFeedClient(
            server: server,
            http: http,
            cursorStore: ChangeCursorStore(directory: tmpDir),
            domainID: "test-domain",
            onEvent: { _ in }
        )
    }

    func testDecodeEventParsesTheServersFractionalSecondsTimestamp() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cf-decode-\(UUID().uuidString)")
        let client = makeClient(tmpDir: tmpDir)
        // Exactly the shape + timestamp format `recordAndPublishAssetChange`
        // emits over SSE — `Date.toISOString()` always includes milliseconds.
        let json = """
        {"cursor":42,"asset_id":"650a1234567890abcdef1234","folder_id":"650a1234567890abcdef5678","kind":"update","abs_path":"/lib/IMG_1.ARW","relative_path":"IMG_1.ARW","at":"2026-05-15T10:00:00.123Z"}
        """

        let event = client.decodeEvent(json)

        XCTAssertNotNil(event, "a real SSE payload with the server's actual timestamp format must decode, not be silently dropped")
        XCTAssertEqual(event?.cursor, 42)
        XCTAssertEqual(event?.assetID, "650a1234567890abcdef1234")
        XCTAssertEqual(event?.kind, .update)
    }

    func testDecodeEventStillParsesAPlainNonFractionalTimestamp() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cf-decode-\(UUID().uuidString)")
        let client = makeClient(tmpDir: tmpDir)
        let json = """
        {"cursor":1,"asset_id":null,"folder_id":null,"kind":"delete","abs_path":null,"at":"2026-05-15T10:00:00Z"}
        """

        let event = client.decodeEvent(json)

        XCTAssertNotNil(event)
        XCTAssertEqual(event?.kind, .delete)
    }

    /// The shared decoder RemoteCatalog and ChangeFeedClient both must use
    /// (#2534). Deliberately does NOT go through `JSONDecoder`'s built-in
    /// `.iso8601` convenience strategy — that's a black box whose
    /// fractional-seconds handling isn't guaranteed across Foundation
    /// versions (RemoteCatalog's own comment documents hitting exactly
    /// this failure, which is why its custom decoder exists at all). This
    /// decoder uses two explicit `ISO8601DateFormatter`s instead, so its
    /// fractional-then-plain fallback is provable independent of any
    /// given Foundation build's leniency.
    func testMapleFileProviderDecoderParsesBothFractionalAndPlainTimestamps() throws {
        struct Wrap: Decodable { let at: Date }
        let decoder = JSONDecoder.mapleFileProviderDecoder()

        let fractional = try decoder.decode(
            Wrap.self, from: Data(#"{"at":"2026-05-15T10:00:00.123Z"}"#.utf8))
        let plain = try decoder.decode(
            Wrap.self, from: Data(#"{"at":"2026-05-15T10:00:00Z"}"#.utf8))

        XCTAssertEqual(fractional.at.timeIntervalSince1970, plain.at.timeIntervalSince1970 + 0.123,
            accuracy: 0.001, "fractional variant is 123ms after the plain one's whole second")
    }
}
