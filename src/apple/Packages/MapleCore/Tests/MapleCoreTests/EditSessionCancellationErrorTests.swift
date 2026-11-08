// EditSessionCancellationErrorTests — a cancellation is never a save error
// (#5735). The editor showed "The operation couldn't be completed.
// (Swift.CancellationError error 1.)" in its red banner because cancelled
// work was stored as the session's sidecar error. Every case round-trips a
// real .xmp beside the committed synthetic DNG in a temp directory.

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

  func testCancelledSidecarReadDoesNotPauseEditing() async throws {
    let session = EditSession(asset: AssetRef(url: try makeRaw()))

    let load = Task { await session.loadSidecar() }
    load.cancel()
    await load.value

    XCTAssertFalse(session.sidecarLoadFailed)
    XCTAssertNil(session.sidecarError)
    await session.loadSidecar()
    XCTAssertTrue(session.hasLoadedSidecar, "a later load still hydrates the session")
  }

  func testCancellationIsClassifiedAcrossItsForms() {
    XCTAssertTrue(CancellationError().isCancellation)
    XCTAssertTrue(URLError(.cancelled).isCancellation)
    XCTAssertTrue(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled).isCancellation)
    XCTAssertFalse(URLError(.timedOut).isCancellation)
    XCTAssertFalse(XMPStoreError.externalConflict(URL(fileURLWithPath: "/x.xmp")).isCancellation)
  }
}
