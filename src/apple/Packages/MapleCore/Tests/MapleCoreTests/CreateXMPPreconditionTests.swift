import XCTest
import Foundation
@testable import MapleCore

/// Regression coverage for #2532: `createXMPItem` used to pass
/// `ifMtimeMatches: nil` unconditionally, which skips the server's
/// precondition check entirely and silently overwrites an existing XMP
/// sidecar. `FileProviderExtensionCore.createOnlyPrecondition` is the
/// helper that replaced that unconditional `nil` — it stats the create
/// target directly (via `RemoteCatalog.statFile`, the real
/// `/api/folders/<id>/file-meta` seam, no mocks) and only returns `nil`
/// when the path is confirmed absent.
final class CreateXMPPreconditionTests: XCTestCase {
  override func setUp() {
    super.setUp()
    StubURLProtocol.register()
    StubURLProtocol.reset()
  }

  override func tearDown() {
    StubURLProtocol.reset()
    super.tearDown()
  }

  private func makeCatalog() -> RemoteCatalog {
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

  /// The bug scenario: a sidecar already exists server-side (the target
  /// path 200s from `/file-meta`), but the OS is calling `createItem`
  /// because its local view doesn't know about it yet. The precondition
  /// must NOT be `nil` — that would let the create clobber it — so it
  /// must be the guaranteed-mismatch sentinel, which forces the server's
  /// existing conflict-copy fallback instead of an overwrite.
  func testCreateOnlyPreconditionGuardsWhenTargetAlreadyExists() async throws {
    var receivedPath: String?
    StubURLProtocol.handler = { req in
      receivedPath = req.url?.path
      XCTAssertEqual(req.url?.query, "path=sub/photo.xmp")
      let body = #"""
      {"name":"photo.xmp","path":"/lib/sub/photo.xmp","mtime":"2026-05-16T00:00:00Z","size":512,"ext":"xmp"}
      """#
      return (200, Data(body.utf8), [:])
    }
    let catalog = makeCatalog()
    let precondition = try await FileProviderExtensionCore.createOnlyPrecondition(
      catalog: catalog,
      folderID: "folder-1",
      relativePath: "sub/photo.xmp"
    )
    XCTAssertEqual(precondition, FileProviderExtensionCore.createGuardMtimeSentinel)
    XCTAssertEqual(receivedPath, "/api/folders/folder-1/file-meta")
  }

  /// The legitimate case: nothing is at the target path yet (`/file-meta`
  /// 404s), so the precondition stays `nil` and the create proceeds
  /// unconditionally exactly as before this fix.
  func testCreateOnlyPreconditionAllowsUnconditionalCreateWhenTargetAbsent() async throws {
    StubURLProtocol.handler = { _ in
      (404, Data(#"{"error":"file not found"}"#.utf8), [:])
    }
    let catalog = makeCatalog()
    let precondition = try await FileProviderExtensionCore.createOnlyPrecondition(
      catalog: catalog,
      folderID: "folder-1",
      relativePath: "sub/photo.xmp"
    )
    XCTAssertNil(precondition)
  }

  /// The sentinel itself must never equal a real on-disk mtime — that's
  /// the whole mechanism the guard relies on to force the server's
  /// mismatch branch. Pin it to the Unix epoch so a future edit can't
  /// accidentally change it to something a real file could plausibly
  /// carry.
  func testCreateGuardMtimeSentinelIsUnixEpoch() {
    XCTAssertEqual(
      FileProviderExtensionCore.createGuardMtimeSentinel,
      Date(timeIntervalSince1970: 0)
    )
  }
}
