// src/apple/Packages/MapleCore/Tests/MapleCoreTests/SidecarModifyIdempotencyTests.swift
import XCTest
import Foundation
@testable import MapleCore

/// #2538 (modify side): a `modifyItem` redelivery for the same sidecar
/// edit arrives with `priorMtime` still pointing at the PRE-write mtime,
/// so its `X-If-Mtime-Matches` precondition mismatches the server's
/// current (post-write) mtime — and a mismatch makes the server WRITE a
/// brand-new conflict-copy file (`pickFreeConflictPath`) rather than
/// merely report one. `FileProviderExtensionCore.isRedundantSidecarWrite`
/// is the precheck that catches this before the write: if the canonical
/// XMP already holds these exact bytes, the edit already landed.
final class SidecarModifyIdempotencyTests: XCTestCase {
    private func makeCatalog(handler: @escaping (URLRequest) -> (Int, Data, [String: String])) -> RemoteCatalog {
        StubURLProtocol.register()
        StubURLProtocol.reset()
        StubURLProtocol.handler = handler
        let session = TestURLSession.make()
        let http = AuthenticatedHTTPClient(
            server: URL(string: "https://x.test")!,
            urlSession: session,
            tokensProvider: { AuthTokens(access: "A1", refresh: "R1") },
            onTokensRefreshed: { _ in },
            onSignOut: {}
        )
        return RemoteCatalog(http: http, server: URL(string: "https://x.test")!, downloadURLSession: session)
    }

    private let validAssetID = "650a1b2c3d4e5f6071829304"

    func testTrueWhenCanonicalAlreadyHoldsTheseExactBytes() async {
        let bytes = Data("<xmp>same</xmp>".utf8)
        let catalog = makeCatalog { _ in (200, bytes, [:]) }
        let redundant = await FileProviderExtensionCore.isRedundantSidecarWrite(
            catalog: catalog, assetID: validAssetID, bytes: bytes)
        XCTAssertTrue(redundant)
    }

    func testFalseWhenCanonicalHoldsDifferentBytes() async {
        let current = Data("<xmp>old</xmp>".utf8)
        let incoming = Data("<xmp>new edit</xmp>".utf8)
        let catalog = makeCatalog { _ in (200, current, [:]) }
        let redundant = await FileProviderExtensionCore.isRedundantSidecarWrite(
            catalog: catalog, assetID: validAssetID, bytes: incoming)
        XCTAssertFalse(redundant)
    }

    /// A network/auth failure fetching the canonical must NOT be treated
    /// as "redundant" — that would make the caller skip a precondition-
    /// guarded write it should actually attempt, silently losing an edit.
    /// Falling through to the normal (pre-#2538) precondition path is the
    /// safe default.
    func testFalseWhenFetchFails() async {
        let catalog = makeCatalog { _ in (500, Data(), [:]) }
        let redundant = await FileProviderExtensionCore.isRedundantSidecarWrite(
            catalog: catalog, assetID: validAssetID, bytes: Data("<xmp/>".utf8))
        XCTAssertFalse(redundant)
    }
}
