import CoreImage
import XCTest

@testable import MapleCore

@MainActor
final class EditorComparisonTests: XCTestCase {
  private var rawFixture: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
  }

  func testRealRawComparisonUsesOpeningModelAndPreservesLiveEditsAndOriginal() async throws {
    let fixture = rawFixture
    let bytes = try Data(contentsOf: fixture)
    let mtime =
      try FileManager.default.attributesOfItem(atPath: fixture.path)[.modificationDate] as? Date
    let asset = AssetRef(displayName: "comparison.dng", hintExtension: "dng") { bytes }
    var original = AdjustmentModel.default
    original.profile = .neutral
    original.autoExposure = .off
    var edited = original
    edited.exposure = 2
    let session = EditSession(asset: asset, model: edited)
    session.originalModel = original
    session.nativeImageSize = CGSize(width: 64, height: 64)
    let comparison = EditorComparison(session: session)
    let request = comparison.request(viewport: CGSize(width: 48, height: 48))

    await comparison.prepare(request)

    let image = try XCTUnwrap(comparison.image, comparison.error ?? "No real original pixels")
    XCTAssertEqual(
      image.extent.size, CGSize(width: 32, height: 32), "Must respect delivered RAW extent")
    let brighter = try await session.renderActor.renderComparison(
      asset: asset, model: edited, target: CGSize(width: 48, height: 48),
      nativeSize: session.nativeImageSize, filmLattice: nil)
    XCTAssertLessThan(
      try red(image), try red(brighter), "Before must actually develop the opening model")
    XCTAssertEqual(session.model, edited)
    XCTAssertFalse(session.canUndo)
    XCTAssertEqual(try Data(contentsOf: fixture), bytes)
    XCTAssertEqual(
      try FileManager.default.attributesOfItem(atPath: fixture.path)[.modificationDate] as? Date,
      mtime)
    await comparison.prepare(request)
    XCTAssertTrue(
      comparison.image === image, "Repeated comparison should reuse the one matching image")
    let live = await session.renderActor.snapshot(forAsset: asset)
    XCTAssertNil(live.image, "Comparison must not replace the live actor's decoded slot")
    XCTAssertEqual(live.decodeGeneration, 0)
  }

  func testCancelledByteBackedComparisonCannotPublishAfterSourceArrives() async throws {
    let bytes = try Data(contentsOf: rawFixture)
    let started = expectation(description: "Original source requested")
    let gate = ComparisonSourceGate()
    let asset = AssetRef(displayName: "delayed.dng", hintExtension: "dng") {
      started.fulfill()
      await gate.wait()
      return bytes
    }
    var model = AdjustmentModel.default
    model.profile = .neutral
    let session = EditSession(asset: asset, model: model)
    let comparison = EditorComparison(session: session)
    let request = comparison.request(viewport: CGSize(width: 32, height: 32))
    let task = Task { await comparison.prepare(request) }
    await fulfillment(of: [started], timeout: 3)
    task.cancel()
    await gate.release()
    await task.value
    XCTAssertNil(comparison.image)
    XCTAssertNil(comparison.error, "A cancelled editor should not announce an error")
    XCTAssertEqual(session.model, model)
    XCTAssertFalse(session.canUndo)
  }

  func testComparisonKeepsCurrentCropWithoutChangingTheOpeningModel() async throws {
    let input = CIImage(color: CIColor(red: 0.2, green: 0.3, blue: 0.4))
      .cropped(to: CGRect(x: 0, y: 0, width: 64, height: 48))
    let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
    let bytes = try XCTUnwrap(
      CIContext().pngRepresentation(of: input, format: .RGBA8, colorSpace: space))
    let asset = AssetRef(displayName: "comparison.png", hintExtension: "png") { bytes }
    var edited = AdjustmentModel.default
    edited.crop = Crop(top: 0.25, left: 0.25, bottom: 0.75, right: 0.75)
    let session = EditSession(asset: asset, model: edited)
    session.originalModel = .default
    session.nativeImageSize = CGSize(width: 64, height: 48)
    let comparison = EditorComparison(session: session)
    let request = comparison.request(viewport: CGSize(width: 64, height: 48))

    await comparison.prepare(request)

    let image = try XCTUnwrap(comparison.image)
    XCTAssertEqual(image.extent.size, CGSize(width: 32, height: 24))
    XCTAssertEqual(session.originalModel.crop, .identity)
    XCTAssertEqual(session.model.crop, edited.crop)
  }

  func testComparisonRequestTracksLateLegacyWhiteBalanceAnchor() {
    let session = EditSession.preview()
    let comparison = EditorComparison(session: session)
    let viewport = CGSize(width: 32, height: 32)
    let before = comparison.request(viewport: viewport)
    session.asShotCCT = 4200
    session.asShotTint = -8
    let after = comparison.request(viewport: viewport)
    XCTAssertNotEqual(before, after)
    XCTAssertEqual(after.asShot, .init(temperature: 4200, tint: -8))
  }

  private func red(_ image: CIImage) throws -> Float {
    var pixel: [Float] = [0, 0, 0, 0]
    let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.linearSRGB))
    CIContext().render(
      image, toBitmap: &pixel, rowBytes: 16,
      bounds: CGRect(x: image.extent.midX, y: image.extent.midY, width: 1, height: 1),
      format: .RGBAf, colorSpace: space)
    return pixel[0]
  }
}

private actor ComparisonSourceGate {
  private var continuation: CheckedContinuation<Void, Never>?
  private var released = false

  func wait() async {
    if released { return }
    await withCheckedContinuation { continuation = $0 }
  }

  func release() {
    released = true
    continuation?.resume()
    continuation = nil
  }
}
