import Darwin
import Foundation
import XCTest

@testable import MapleCore

/// #3940: actual post-rename directory-access loss in an owned Darwin child.
@MainActor
final class LocalRemovalRecoveryProbeTests: XCTestCase {
  private func fixture(_ name: String, _ extensionName: String) throws -> Data {
    let url = try XCTUnwrap(
      Bundle.module.url(
        forResource: name, withExtension: extensionName, subdirectory: "removal/calibration"))
    return try Data(contentsOf: url)
  }

  private func arm(_ raw: URL) throws {
    let sidecar = SidecarPath.sidecarURL(for: raw)
    let number = try XCTUnwrap(
      FileManager.default.attributesOfItem(atPath: sidecar.path)[.systemFileNumber] as? NSNumber)
    try Data(String(number.uint64Value).utf8).write(
      to: raw.deletingLastPathComponent().appendingPathComponent(".revoke-sidecar-access"))
  }

  private func restoreAccess(_ root: URL) throws {
    XCTAssertEqual(chmod(root.path, 0o700), 0)
    try FileManager.default.removeItem(at: root.appendingPathComponent(".revoke-sidecar-access"))
  }

  private func disk(_ raw: URL) throws -> AdjustmentModel {
    try XMPParser.parse(data: Data(contentsOf: SidecarPath.sidecarURL(for: raw))).0
  }

  private func failedKeep() async throws -> (
    raw: URL, session: EditSession, proposal: NativeRemovalProposal,
    snapshot: RemovalAuthoringSnapshot
  ) {
    guard
      ProcessInfo.processInfo.environment["DYLD_INSERT_LIBRARIES"]?
        .contains("mac-removal-postrename-access-probe") == true
    else { throw XCTSkip("Owned Darwin permission-revocation probe required (#3940)") }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "removal-keep-recovery-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    addTeardownBlock {
      _ = chmod(root.path, 0o700)
      try? FileManager.default.removeItem(at: root)
    }
    let raw = root.appendingPathComponent("photo.dng")
    try fixture("source", "dng").write(to: raw)
    try fixture("prior", "xmp").write(to: SidecarPath.sidecarURL(for: raw))
    let session = EditSession(asset: AssetRef(url: raw))
    let proposal = NativeRemovalProposal(
      request: String(decoding: try fixture("request", "txt"), as: UTF8.self),
      mask: try fixture("mask", "mimf"), patch: try fixture("patch", "f16"))
    let snapshot = try await session.removalAuthoringSnapshot()
    try arm(raw)
    do {
      try await session.acceptRemoval(proposal, snapshot: snapshot)
      XCTFail("Actual post-rename directory access must fail")
    } catch {
      XCTAssertEqual((error as NSError).domain, NSPOSIXErrorDomain)
      XCTAssertEqual((error as NSError).code, Int(EACCES))
    }
    try restoreAccess(root)
    XCTAssertEqual(session.model, snapshot.model)
    XCTAssertNotNil(try disk(raw).inpaintRemovals)
    return (raw, session, proposal, snapshot)
  }

  func testSameRemovalStackCannotAuthorizeAChangedExternalSidecarAfterPartialSave() async throws {
    let staged = try await failedKeep()
    let sidecar = SidecarPath.sidecarURL(for: staged.raw)
    let published = try String(contentsOf: sidecar, encoding: .utf8)
    XCTAssertTrue(published.contains("untouched"))
    let external = published.replacingOccurrences(of: "untouched", with: "external edit")
    try Data(external.utf8).write(to: sidecar, options: .atomic)
    do {
      try await staged.session.acceptRemoval(staged.proposal, snapshot: staged.snapshot)
      XCTFail("A matching removal field cannot bless changed complete XML")
    } catch RemovalError.saveConflict {}
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), external)
    XCTAssertEqual(staged.session.model, staged.snapshot.model)
    XCTAssertTrue(staged.session.undoHistory.isEmpty)
    XCTAssertEqual(try Data(contentsOf: staged.raw), try fixture("source", "dng"))
    await staged.session.releaseTransientMemory()
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), external)
  }

  func testChangedOriginalRefusesReconciliationOfAlreadyPublishedRemoval() async throws {
    let staged = try await failedKeep()
    let sidecar = SidecarPath.sidecarURL(for: staged.raw)
    let published = try Data(contentsOf: sidecar)
    let replacement = Data("external replacement of staged original".utf8)
    try replacement.write(to: staged.raw)
    do {
      try await staged.session.acceptRemoval(staged.proposal, snapshot: staged.snapshot)
      XCTFail("An attempted publication cannot bypass changed original identity")
    } catch RemovalError.invalid {}
    XCTAssertEqual(try Data(contentsOf: staged.raw), replacement)
    XCTAssertEqual(try Data(contentsOf: sidecar), published)
    XCTAssertEqual(staged.session.model, staged.snapshot.model)
    XCTAssertTrue(staged.session.undoHistory.isEmpty)
    await staged.session.releaseTransientMemory()
  }

  func testKeepUndoRedoRecoverAfterRealPostRenamePermissionLoss() async throws {
    #if os(macOS)
      guard
        ProcessInfo.processInfo.environment["DYLD_INSERT_LIBRARIES"]?
          .contains("mac-removal-postrename-access-probe") == true
      else { throw XCTSkip("Owned Darwin permission-revocation probe required (#3940)") }
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(
        "removal-keep-recovery-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      defer {
        _ = chmod(root.path, 0o700)
        try? FileManager.default.removeItem(at: root)
      }
      let raw = root.appendingPathComponent("photo.dng")
      let original = try fixture("source", "dng")
      try original.write(to: raw)
      try fixture("prior", "xmp").write(to: SidecarPath.sidecarURL(for: raw))
      let session = EditSession(asset: AssetRef(url: raw))
      let proposal = NativeRemovalProposal(
        request: String(decoding: try fixture("request", "txt"), as: UTF8.self),
        mask: try fixture("mask", "mimf"), patch: try fixture("patch", "f16"))
      let snapshot = try await session.removalAuthoringSnapshot()
      let before = session.model
      try arm(raw)
      do {
        try await session.acceptRemoval(proposal, snapshot: snapshot)
        XCTFail("Directory read permission must be lost after the real XMP replacement")
      } catch {
        XCTAssertEqual((error as NSError).domain, NSPOSIXErrorDomain)
        XCTAssertEqual((error as NSError).code, Int(EACCES))
      }
      try restoreAccess(root)
      XCTAssertEqual(session.model, before)
      XCTAssertTrue(session.undoHistory.isEmpty)
      XCTAssertNotNil(try disk(raw).inpaintRemovals)
      XCTAssertNotNil(session.sidecarError)
      try await session.acceptRemoval(proposal, snapshot: snapshot)
      await session.flushPendingSidecarWrite()
      let accepted = session.model
      XCTAssertNil(session.sidecarError)
      XCTAssertEqual(try disk(raw), accepted)
      XCTAssertEqual(session.undoHistory.count, 1)
      XCTAssertEqual(try RemovalBridge.assetNames(records: accepted.inpaintRemovals!.json).count, 2)

      try arm(raw)
      session.undo()
      await session.flushPendingSidecarWrite()
      try restoreAccess(root)
      XCTAssertNotNil(session.sidecarError)
      XCTAssertEqual(session.model, accepted)
      XCTAssertNil(try disk(raw).inpaintRemovals)
      XCTAssertEqual(session.undoHistory.count, 1)
      XCTAssertTrue(session.transactions.redoStack.isEmpty)
      session.undo()
      await session.flushPendingSidecarWrite()
      XCTAssertNil(session.sidecarError)
      XCTAssertEqual(session.model, before)
      XCTAssertEqual(try disk(raw), before)
      XCTAssertTrue(session.undoHistory.isEmpty)
      XCTAssertEqual(session.transactions.redoStack.count, 1)

      try arm(raw)
      session.redo()
      await session.flushPendingSidecarWrite()
      try restoreAccess(root)
      XCTAssertNotNil(session.sidecarError)
      XCTAssertEqual(session.model, before)
      XCTAssertNotNil(try disk(raw).inpaintRemovals)
      XCTAssertEqual(session.transactions.redoStack.count, 1)
      session.redo()
      await session.flushPendingSidecarWrite()
      XCTAssertNil(session.sidecarError)
      XCTAssertEqual(session.model, accepted)
      XCTAssertEqual(try disk(raw), accepted)
      XCTAssertEqual(session.undoHistory.count, 1)
      XCTAssertTrue(session.transactions.redoStack.isEmpty)
      XCTAssertEqual(try Data(contentsOf: raw), original)
      await session.releaseTransientMemory()
    #else
      throw XCTSkip("Actual Darwin directory-access probe runs on macOS (#3940)")
    #endif
  }
}
