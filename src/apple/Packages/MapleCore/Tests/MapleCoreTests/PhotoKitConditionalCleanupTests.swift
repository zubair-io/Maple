import MapleBackup
import XCTest

@testable import MapleCore

final class PhotoKitConditionalCleanupTests: XCTestCase {
  func testNewerProductionEditorXMPIsPreserved() async throws {
    let (backing, root) = try freshBacking()
    defer { try? FileManager.default.removeItem(at: root) }
    let id = "PHOTO/L0/002"
    let editor = PhotoKitSidecarStore(phassetLocalId: id, sidecars: backing)
    var first = AdjustmentModel.default
    first.exposure = 1
    try await editor.writeConfirmed(model: first, culling: CullingState())
    let sent = try XCTUnwrap(backing.read(phassetLocalId: id))

    var newer = AdjustmentModel.default
    newer.exposure = 2
    try await editor.writeConfirmed(model: newer, culling: CullingState())
    let latest = try XCTUnwrap(backing.read(phassetLocalId: id))
    XCTAssertNotEqual(latest, sent)

    XCTAssertFalse(try backing.deleteIfUnchanged(phassetLocalId: id, matching: sent))
    XCTAssertEqual(try backing.read(phassetLocalId: id), latest)
  }

  func testAcknowledgedProductionEditorXMPIsRemovedWhenUnchanged() async throws {
    let (backing, root) = try freshBacking()
    defer { try? FileManager.default.removeItem(at: root) }
    let id = "PHOTO/L0/003"
    let editor = PhotoKitSidecarStore(phassetLocalId: id, sidecars: backing)
    var model = AdjustmentModel.default
    model.exposure = 1
    try await editor.writeConfirmed(model: model, culling: CullingState())
    let sent = try XCTUnwrap(backing.read(phassetLocalId: id))

    XCTAssertTrue(try backing.deleteIfUnchanged(phassetLocalId: id, matching: sent))
    XCTAssertNil(try backing.read(phassetLocalId: id))
    XCTAssertFalse(try backing.deleteIfUnchanged(phassetLocalId: id, matching: sent))
  }

  private func freshBacking() throws -> (AppSupportSidecarStore, URL) {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent(
        "photokit-conditional-cleanup-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return (AppSupportSidecarStore(root: root), root)
  }
}
