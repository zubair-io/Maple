// EditSessionCancellationErrorTests — a cancellation is never a save error
// (#5735). The editor showed "The operation couldn't be completed.
// (Swift.CancellationError error 1.)" in its red banner because cancelled
// work was stored as the session's sidecar error. Local cases round-trip a
// real .xmp beside the committed synthetic DNG in a temp directory; cloud
// cases fake only the HTTP transport, as CloudSidecarStoreTests does.

import XCTest

@testable import MapleCore

@MainActor
final class EditSessionCancellationErrorTests: EditorTestCase {
  private static let syntheticDNG: URL = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    return url.appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
  }()

  private func makeRaw() throws -> URL {
    let dir = try SidecarContractIO.makeTempDirectory(prefix: "cancellation-error")
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    let raw = dir.appendingPathComponent("grey.dng")
    try FileManager.default.copyItem(at: Self.syntheticDNG, to: raw)
    return raw
  }

  private func savedCulling(beside raw: URL) throws -> CullingState {
    try XMPParser.parse(data: Data(contentsOf: SidecarPath.sidecarURL(for: raw))).1
  }

  func testLeavingAnUnloadedEditorShowsNoSaveError() async throws {
    let session = EditSession(asset: AssetRef(url: try makeRaw()))

    await session.persistDisplayPreviewOnExit()

    XCTAssertNil(session.sidecarError)
    XCTAssertFalse(session.sidecarLoadFailed)
  }

  func testCancelledExitWithAQueuedRatingShowsNoSaveError() async throws {
    let raw = try makeRaw()
    let session = EditSession(asset: AssetRef(url: raw))
    session.culling.stars = 3

    let exit = Task { await session.persistDisplayPreviewOnExit() }
    exit.cancel()
    await exit.value

    XCTAssertNil(session.sidecarError, "a cancelled exit is not a failed save")
    XCTAssertFalse(session.sidecarLoadFailed)

    try await session.flushPendingSidecarWriteConfirmed()
    XCTAssertEqual(try savedCulling(beside: raw).stars, 3, "the queued rating still lands")
  }

  func testCancelledConfirmedFlushReportsCancellationNotASaveError() async throws {
    let session = EditSession(asset: AssetRef(url: try makeRaw()))
    session.culling.stars = 2

    let flush = Task { try await session.flushPendingSidecarWriteConfirmed() }
    flush.cancel()
    do {
      try await flush.value
      XCTFail("a cancelled flush with an unmerged rating must not report success")
    } catch {
      XCTAssertTrue(error is CancellationError)
    }
    XCTAssertNil(session.sidecarError)
  }

  private func cloudSession(cancelledReads: Int) -> EditSession {
    let server = URL(string: "https://cloud.example.test")!
    let remaining = LockedCounter(cancelledReads)
    let notFound: (URLRequest) -> (Data, HTTPURLResponse) = { request in
      let response = HTTPURLResponse(
        url: request.url!, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!
      return (Data(), response)
    }
    let urlSession = URLSession.stubbedSequence(
      errorProvider: { _ in remaining.takeOne() ? URLError(.cancelled) : nil }, notFound)
    let store = CloudSidecarStore(
      server: server, assetID: "a-5735",
      httpClient: .unauthenticated(server: server, urlSession: urlSession))
    let asset = AssetRef(
      displayName: "IMG_5735", hintExtension: "dng", stableID: "a-5735",
      bytesProvider: { throw URLError(.notConnectedToInternet) })
    return EditSession(asset: asset, remoteSidecarStore: store)
  }

  func testSidecarReadCancelledElsewhereStillHydrates() async {
    let session = cloudSession(cancelledReads: 1)

    await session.loadSidecar()

    XCTAssertTrue(session.hasLoadedSidecar, "one dropped read is retried, not treated as failed")
    XCTAssertFalse(session.sidecarLoadFailed)
    XCTAssertNil(session.sidecarError)
  }

  func testRepeatedlyCancelledSidecarReadPausesEditingWithRetry() async {
    let session = cloudSession(cancelledReads: 2)

    await session.loadSidecar()

    XCTAssertFalse(session.hasLoadedSidecar)
    XCTAssertTrue(
      session.sidecarLoadFailed, "a read the editor did not cancel must offer the Retry notice")
    await session.loadSidecar()
    XCTAssertTrue(session.hasLoadedSidecar, "Retry hydrates once the connection recovers")
  }

  func testCancellationIsClassifiedAcrossItsForms() {
    XCTAssertTrue(CancellationError().isCancellation)
    XCTAssertTrue(URLError(.cancelled).isCancellation)
    XCTAssertTrue(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled).isCancellation)
    XCTAssertFalse(URLError(.timedOut).isCancellation)
    XCTAssertFalse(XMPStoreError.externalConflict(URL(fileURLWithPath: "/x.xmp")).isCancellation)
  }
}

private final class LockedCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var remaining: Int

  init(_ remaining: Int) { self.remaining = remaining }

  func takeOne() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard remaining > 0 else { return false }
    remaining -= 1
    return true
  }
}
