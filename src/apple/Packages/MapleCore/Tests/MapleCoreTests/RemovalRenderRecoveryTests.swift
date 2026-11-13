import Foundation
import XCTest

@testable import MapleCore

final class RemovalRenderRecoveryTests: XCTestCase {
  private func fixture(_ name: String, _ ext: String) throws -> Data {
    let url = try XCTUnwrap(
      Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "removal/calibration"))
    return try Data(contentsOf: url)
  }

  @MainActor
  func testMissingAndCorruptCompanionsRemainVisibleUntilRestoredAndRetried() async throws {
    for corrupt in [false, true] {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let raw = directory.appendingPathComponent("photo.dng")
      let original = try fixture("source", "dng")
      try original.write(to: raw)
      let xmp = try fixture("saved", "xmp")
      let sidecar = SidecarPath.sidecarURL(for: raw)
      try xmp.write(to: sidecar)
      let assets = directory.appendingPathComponent(".maple/inpaint")
      try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
      let mask = try fixture("mask", "mimf")
      let patch = try fixture("patch", "f16")
      let maskName = String(try RemovalBridge.digest(mask).dropFirst(7)) + ".mask"
      let patchName = String(try RemovalBridge.digest(patch).dropFirst(7)) + ".f16"
      let maskURL = assets.appendingPathComponent(maskName)
      try patch.write(to: assets.appendingPathComponent(patchName))
      if corrupt { try Data("damaged mask".utf8).write(to: maskURL) }
      let model = try XMPParser.parse(data: xmp).0
      let session = EditSession(asset: AssetRef(url: raw), model: model)
      let state = EditorState(session: session, armedTool: .remove)

      await session.renderFull()
      let error = try XCTUnwrap(session.renderError)
      XCTAssertNil(
        session.renderedPreview, "An incomplete edit must not publish original-only pixels")
      XCTAssertFalse(session.isRendering)
      await state.removal.open()
      XCTAssertEqual(state.removal.phase, .failed)
      await state.retryRendering()
      XCTAssertEqual(state.removal.phase, .failed)
      XCTAssertNotNil(session.renderError, "Retry cannot clear a still-incomplete edit")
      if corrupt {
        XCTAssertTrue(error is RemovalError, "Corruption must retain the companion diagnosis")
      } else {
        guard case RemovalError.missingCompanion(let name) = error else {
          XCTFail("Missing companions must retain their identity: \(error)")
          await session.releaseTransientMemory()
          continue
        }
        XCTAssertEqual(name, maskName)
      }
      do {
        _ = try await MapleExporter.exportData(session: session, options: .init(format: .png))
        XCTFail("An incomplete saved edit must not export the original")
      } catch {}
      XCTAssertEqual(try Data(contentsOf: raw), original)
      XCTAssertEqual(try Data(contentsOf: sidecar), xmp)

      try mask.write(to: maskURL)
      await state.retryRendering()
      XCTAssertNil(session.renderError, "Retry after restoration must clear the failure")
      XCTAssertNotNil(session.renderedPreview)
      XCTAssertEqual(state.removal.phase, .ready)
      XCTAssertEqual(state.removal.savedRemovals.count, 1)
      let delivered = try await MapleExporter.exportData(
        session: session, options: .init(format: .png))
      XCTAssertFalse(delivered.isEmpty)
      XCTAssertEqual(try Data(contentsOf: raw), original)
      XCTAssertEqual(try Data(contentsOf: sidecar), xmp)
      XCTAssertEqual(try Data(contentsOf: maskURL), mask)
      XCTAssertEqual(try Data(contentsOf: assets.appendingPathComponent(patchName)), patch)
      await session.releaseTransientMemory()
    }
  }
}
