import CoreImage
import Foundation
import XCTest

@testable import MapleCore

final class WorkflowVariantCacheTests: XCTestCase {
  @MainActor
  func testNamedBranchCannotSeedFromThePrimaryDerivedPreview() async throws {
    let (_, original, _, _) = try files()
    let preview = MapleSidecarPaths.previewURL(for: original)
    try FileManager.default.createDirectory(
      at: preview.deletingLastPathComponent(), withIntermediateDirectories: true)
    let context = CIContext()
    let data = try XCTUnwrap(
      context.pngRepresentation(
        of: image(.blue), format: .RGBA8,
        colorSpace: CGColorSpaceCreateDeviceRGB(), options: [:]))
    try data.write(to: preview)
    let session = EditSession(asset: AssetRef(url: original))
    let primarySeeded = await session.seedFromMapleSidecarPreview(for: session.asset)
    XCTAssertTrue(primarySeeded, "Exercise the actual primary derived image reader")
    await session.workflow.createVariant(name: "Night", session: session)
    XCTAssertNil(session.workflow.errorText)
    XCTAssertNil(session.renderedPreview)
    let namedSeeded = await session.seedFromMapleSidecarPreview(for: session.asset)
    XCTAssertFalse(namedSeeded)
    XCTAssertNil(session.renderedPreview, "Primary pixels cannot stand in for a named branch")
    XCTAssertEqual(try Data(contentsOf: preview), data)
    await session.renderActor.cancelAll()
  }

  func testEqualTimestampsKeepActualSiblingPreviewsSeparateOnDisk() async throws {
    let (root, original, primary, named) = try files()
    let cache = RenderedPreviewCache()
    await cache.configure(folderURL: root)
    await cache.storePreview(image(.green), for: original, screenWidth: 64)
    await cache.storePreview(image(.blue), for: original, screenWidth: 64, sidecarURL: named)
    let reopened = RenderedPreviewCache()
    await reopened.configure(folderURL: root)
    let primaryHit = await reopened.preview(for: original, screenWidth: 64)
    let namedHit = await reopened.preview(for: original, screenWidth: 64, sidecarURL: named)
    let primaryImage = try XCTUnwrap(primaryHit)
    let namedImage = try XCTUnwrap(namedHit)
    XCTAssertNotEqual(pixel(primaryImage), pixel(namedImage))
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(
        atPath: root.appendingPathComponent(".maple/previews").path
      ).count, 2)
    try FileManager.default.setAttributes(
      [.modificationDate: stamp.addingTimeInterval(1)], ofItemAtPath: primary.path)
    let stalePrimary = await reopened.preview(for: original, screenWidth: 64)
    let stillNamed = await reopened.preview(for: original, screenWidth: 64, sidecarURL: named)
    XCTAssertNil(stalePrimary)
    XCTAssertNotNil(stillNamed)
    try FileManager.default.removeItem(at: named)
    let missing = await reopened.preview(for: original, screenWidth: 64, sidecarURL: named)
    XCTAssertNil(missing, "A missing sibling cannot acquire the primary cached preview")
  }

  func testSwitchAcceptsSameBakedPixelsAndRejectsDifferentBakedSiblingAtEqualMtime() async throws {
    let (_, original, primary, named) = try files()
    let primaryBytes = try Data(contentsOf: primary)
    let originalBytes = try Data(contentsOf: original)
    let asset = AssetRef(url: original)
    var selected = asset
    selected.selectedSidecarURL = named
    let actor = RenderActor(pipeline: ImageEditPipeline())
    let decoded = image(.gray)
    await actor._testSeedDecodedCache(
      asset: asset, decoded: decoded,
      rawResolution: decoded.extent.size)
    let before = await actor.snapshot(forAsset: asset)
    let warm = await actor.snapshot(forAsset: selected)
    XCTAssertTrue(warm.isFresh, "Exposure is applied live and shares the decoded RAW")
    XCTAssertTrue(warm.image === before.image)
    XCTAssertEqual(warm.decodeGeneration, before.decodeGeneration)
    let acceptedURL = await actor.decodedSidecarURL
    XCTAssertEqual(acceptedURL, named)
    var changed = AdjustmentModel.default
    changed.highlightRecovery = .luminance
    let other = named.deletingLastPathComponent().appendingPathComponent("other.xmp")
    try write(changed, to: other)
    selected.selectedSidecarURL = other
    let stale = await actor.snapshot(forAsset: selected)
    XCTAssertFalse(stale.isFresh, "Equal timestamps cannot hide a different decode-baked model")
    let originalAgain = await actor.snapshot(forAsset: asset)
    XCTAssertTrue(originalAgain.isFresh)
    XCTAssertEqual(try Data(contentsOf: primary), primaryBytes)
    XCTAssertEqual(try Data(contentsOf: original), originalBytes)
  }

  func testCapturedSiblingWriteUsesOnlyThatSiblingRevision() async throws {
    let (root, original, primary, named) = try files()
    let cache = RenderedPreviewCache()
    await cache.configure(folderURL: root)
    let captured = await cache.captureWrite(for: original, screenWidth: 64, sidecarURL: named)
    let snapshot = try XCTUnwrap(captured)
    try FileManager.default.setAttributes(
      [.modificationDate: stamp.addingTimeInterval(1)], ofItemAtPath: primary.path)
    await cache.storePreview(image(.blue), for: snapshot)
    let hit = await cache.preview(for: original, screenWidth: 64, sidecarURL: named)
    XCTAssertNotNil(hit)
    let capturedAgain = await cache.captureWrite(for: original, screenWidth: 64, sidecarURL: named)
    let staleSnapshot = try XCTUnwrap(capturedAgain)
    try FileManager.default.setAttributes(
      [.modificationDate: stamp.addingTimeInterval(2)], ofItemAtPath: named.path)
    await cache.storePreview(image(.red), for: staleSnapshot)
    let stale = await cache.preview(for: original, screenWidth: 64, sidecarURL: named)
    XCTAssertNil(stale)
  }

  private var stamp: Date { Date(timeIntervalSince1970: 1_700_000_000) }

  private func files() throws -> (URL, URL, URL, URL) {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    let original = root.appendingPathComponent("original.png")
    try SidecarContractIO.makeSyntheticOriginal(at: original)
    let primary = SidecarPath.sidecarURL(for: original)
    let id = UUID().uuidString.lowercased()
    let named = root.appendingPathComponent(
      try WorkflowSidecarCore.variantFilename(
        primaryName: primary.lastPathComponent, variantId: id))
    try write(.default, to: primary)
    var model = AdjustmentModel.default
    model.exposure = 1.25
    let checkpoint = XMPSerializer.serialize(model: model, culling: CullingState())
    let xml = try WorkflowSidecarCore.embed(
      SidecarWorkflow(
        schemaVersion: 1, variantId: id, variantName: "Night", snapshots: [], history: []),
      in: checkpoint)
    try xml.write(to: named, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.modificationDate: stamp], ofItemAtPath: named.path)
    return (root, original, primary, named)
  }

  private func write(_ model: AdjustmentModel, to url: URL) throws {
    try XMPSerializer.serialize(model: model, culling: CullingState())
      .write(to: url, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.modificationDate: stamp], ofItemAtPath: url.path)
  }

  private func image(_ color: CIColor) -> CIImage {
    CIImage(color: color).cropped(to: CGRect(x: 0, y: 0, width: 64, height: 32))
  }

  private func pixel(_ image: CIImage) -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: 4)
    CIContext().render(
      image, toBitmap: &bytes, rowBytes: 4,
      bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBA8,
      colorSpace: CGColorSpaceCreateDeviceRGB())
    return bytes
  }
}
