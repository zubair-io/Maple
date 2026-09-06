import CoreImage
import XCTest

@testable import MapleCore

final class RenderedPreviewCacheWriteTests: XCTestCase {
  func testQueuedWriteCannotAcquireNewerSidecarRevision() async throws {
    let (cache, original, root) = try await makeCache()
    let captured = await cache.captureWrite(for: original, screenWidth: 64)
    let snapshot = try XCTUnwrap(captured)
    let sidecar = SidecarPath.sidecarURL(for: original)
    var model = AdjustmentModel.default
    model.exposure = 2
    try XMPSerializer.serialize(model: model, culling: CullingState())
      .write(to: sidecar, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes(
      [.modificationDate: Date(timeIntervalSince1970: 1_800_000_000)], ofItemAtPath: sidecar.path)
    await cache.storePreview(image(), for: snapshot)
    let wrongRevision = await cache.preview(for: original, screenWidth: 64)
    XCTAssertNil(wrongRevision)
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(
        atPath: root.appendingPathComponent(".maple/previews").path
      ).count, 0)
  }

  func testQueuedWriteKeepsOriginalFolderAndLateCaptureRejectsDifferentFolder() async throws {
    let (cache, original, root) = try await makeCache()
    let captured = await cache.captureWrite(for: original, screenWidth: 64)
    let snapshot = try XCTUnwrap(captured)
    let other = root.appendingPathComponent("other")
    await cache.configure(folderURL: other)
    let lateCapture = await cache.captureWrite(for: original, screenWidth: 64)
    XCTAssertNil(lateCapture, "An old session must not capture the new folder's destination")
    await cache.storePreview(image(), for: snapshot)
    let originalFiles = try FileManager.default.contentsOfDirectory(
      atPath: root.appendingPathComponent(".maple/previews").path)
    let otherFiles = try FileManager.default.contentsOfDirectory(
      atPath: other.appendingPathComponent(".maple/previews").path)
    XCTAssertEqual(originalFiles.count, 1)
    XCTAssertTrue(otherFiles.isEmpty)
    let reopened = RenderedPreviewCache()
    await reopened.configure(folderURL: root)
    let persisted = await reopened.preview(for: original, screenWidth: 64)
    XCTAssertNotNil(persisted)
  }

  private func makeCache() async throws -> (RenderedPreviewCache, URL, URL) {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    let original = root.appendingPathComponent("original.png")
    try SidecarContractIO.makeSyntheticOriginal(at: original)
    try XMPSerializer.serialize(model: .default, culling: CullingState())
      .write(to: SidecarPath.sidecarURL(for: original), atomically: true, encoding: .utf8)
    let cache = RenderedPreviewCache()
    await cache.configure(folderURL: root)
    return (cache, original, root)
  }

  private func image() -> CIImage {
    CIImage(color: .green).cropped(to: CGRect(x: 0, y: 0, width: 64, height: 32))
  }
}
