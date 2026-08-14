// src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogXMPCreateTests.swift
import XCTest
@testable import MapleCore

/// Covers `RemoteCatalog.putXMP`'s `requireAbsent` create-only precondition
/// (Apple audit #2532). `ifMtimeMatches: nil` alone means "unconditional
/// write" — correct for a modify with no known prior version, wrong for a
/// create, which must never silently clobber a sidecar that already exists
/// server-side. `requireAbsent: true` sends a distinct signal the server
/// treats as a create-only precondition. Uses `URLProtocolStub` — no network.
final class RemoteCatalogXMPCreateTests: XCTestCase {

    func testPutXMPWithRequireAbsentSendsRequireAbsentHeaderAndOmitsIfMtimeMatches() async throws {
        let server = URL(string: "https://example.test")!
        let observed = XMPRequestObserver()
        let session = URLSession.stubbedSequence { req in
            observed.record(
                path: req.url?.path,
                requireAbsent: req.value(forHTTPHeaderField: "X-Maple-Require-Absent"),
                ifMtimeMatches: req.value(forHTTPHeaderField: "X-If-Mtime-Matches"))
            let resp = HTTPURLResponse(url: req.url!, statusCode: 204,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Last-Modified": "Wed, 15 May 2026 10:00:00 GMT"])!
            return (Data(), resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)

        // A concrete (non-nil) `ifMtimeMatches` — e.g. `createXMPItem`'s local
        // `createOnlyPrecondition` stat found something and passed the
        // guaranteed-mismatch sentinel — must still be suppressed once
        // `requireAbsent` is true. Passing `nil` here would make the
        // `XCTAssertNil` below trivially true regardless of the precedence
        // logic in `putXMP`; a concrete Date is required to prove
        // `requireAbsent` actually wins.
        let result = try await cat.putXMP(
            assetID: "650a1234567890abcdef1234",
            data: Data("<x:xmpmeta/>".utf8),
            ifMtimeMatches: Date(timeIntervalSince1970: 0),
            deviceName: "test-device",
            requireAbsent: true
        )

        guard case .ok = result else {
            return XCTFail("expected .ok, got \(result)")
        }
        let snap = observed.snapshot()
        XCTAssertEqual(snap.path, "/api/assets/650a1234567890abcdef1234/xmp")
        XCTAssertEqual(snap.requireAbsent, "true")
        // `requireAbsent` takes priority over `ifMtimeMatches` — the
        // precondition header must not be sent alongside require-absent,
        // even though a concrete mtime was supplied above.
        XCTAssertNil(snap.ifMtimeMatches)
    }

    func testPutXMPWithRequireAbsentReturnsConflictOn409() async throws {
        let server = URL(string: "https://example.test")!
        let session = URLSession.stubbedSequence { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 409,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
            let body = Data(#"{"conflict_path":"/lib/IMG_1 (conflict from test-device).xmp","conflict_mtime":"2026-05-15T10:00:00.000Z"}"#.utf8)
            return (body, resp)
        }
        let http = AuthenticatedHTTPClient.unauthenticated(server: server, urlSession: session)
        let cat = RemoteCatalog(http: http, server: server)

        let result = try await cat.putXMP(
            assetID: "650a1234567890abcdef1234",
            data: Data("<x:xmpmeta/>".utf8),
            ifMtimeMatches: nil,
            deviceName: "test-device",
            requireAbsent: true
        )

        guard case .conflict(let path, _) = result else {
            return XCTFail("expected .conflict, got \(result)")
        }
        XCTAssertTrue(path.contains("conflict from test-device"))
    }
}

private final class XMPRequestObserver: @unchecked Sendable {
    struct Snapshot { var path: String?; var requireAbsent: String?; var ifMtimeMatches: String? }
    private let lock = NSLock()
    private var snap = Snapshot()
    func record(path: String?, requireAbsent: String?, ifMtimeMatches: String?) {
        lock.lock(); defer { lock.unlock() }
        snap = Snapshot(path: path, requireAbsent: requireAbsent, ifMtimeMatches: ifMtimeMatches)
    }
    func snapshot() -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        return snap
    }
}
