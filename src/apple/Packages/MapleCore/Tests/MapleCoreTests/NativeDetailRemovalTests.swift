import CoreImage
import Foundation
import XCTest

@testable import MapleCore

final class NativeDetailRemovalTests: XCTestCase {
  private func data(_ name: String, _ ext: String) throws -> Data {
    let url = try XCTUnwrap(
      Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "removal/calibration"))
    return try Data(contentsOf: url)
  }

  private func stage() throws -> (URL, String) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let companions = directory.appendingPathComponent(".maple/inpaint")
    try FileManager.default.createDirectory(at: companions, withIntermediateDirectories: true)
    let raw = directory.appendingPathComponent("photo.dng")
    try data("source", "dng").write(to: raw)
    for (name, ext, suffix) in [("mask", "mimf", "mask"), ("patch", "f16", "f16")] {
      let content = try data(name, ext)
      let digest = try RemovalBridge.digest(content).dropFirst(7)
      try content.write(to: companions.appendingPathComponent("\(digest).\(suffix)"))
    }
    let xml = String(decoding: try data("saved", "xmp"), as: UTF8.self)
    try xml.write(to: SidecarPath.sidecarURL(for: raw), atomically: true, encoding: .utf8)
    return (raw, xml)
  }

  private func pixels(_ image: CIImage) -> [Float] {
    let width = Int(image.extent.width)
    let height = Int(image.extent.height)
    var output = [Float](repeating: 0, count: width * height * 4)
    output.withUnsafeMutableBytes {
      CIContext().render(
        image, toBitmap: $0.baseAddress!, rowBytes: width * 16,
        bounds: image.extent, format: .RGBAf,
        colorSpace: CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!)
    }
    return output
  }

  func testNormalEditorNativeDetailMatchesAcceptedWholeSceneAndRetainsCompanionsAcrossPans()
    async throws
  {
    let (raw, xml) = try stage()
    var model = try XMPParser.parse(xml).0
    model.profile = .neutral
    model.autoExposure = .off
    let asset = AssetRef(url: raw)
    let fullResult = await ImageEditPipeline().decodeSceneLinearSized(
      asset: asset, targetSize: CGSize(width: 16, height: 8),
      xmpPath: SidecarPath.sidecarURL(for: raw), quality: .full,
      profileOverride: .neutral, autoExposureOverride: .off)
    let full = try XCTUnwrap(fullResult)
    let renderer = NativeDetailRenderer()
    for x in [0, 3] {
      let sourceRect = CGRect(x: x, y: 1, width: 8, height: 4)
      let image = try await renderer.render(
        asset: asset, sourceRect: sourceRect, model: model, aeGain: 1)
      let expectedRect = CGRect(x: x, y: 3, width: 8, height: 4)
      let actual = pixels(image)
      let expected = pixels(full.image.cropped(to: expectedRect))
      XCTAssertEqual(actual.count, expected.count)
      for (a, b) in zip(actual, expected) { XCTAssertEqual(a, b, accuracy: 0.00001) }
      if x == 0 {
        try FileManager.default.removeItem(
          at: raw.deletingLastPathComponent().appendingPathComponent(".maple/inpaint"))
        try FileManager.default.removeItem(at: SidecarPath.sidecarURL(for: raw))
      }
    }
    model.exposure = 1.5  // Live grade is replayed downstream, not baked into a new owner.
    let unity = try await renderer.render(
      asset: asset, sourceRect: CGRect(x: 3, y: 1, width: 8, height: 4), model: model, aeGain: 1)
    let gained = try await renderer.render(
      asset: asset, sourceRect: CGRect(x: 3, y: 1, width: 8, height: 4), model: model, aeGain: 1.75)
    for (index, pair) in zip(pixels(unity), pixels(gained)).enumerated() {
      XCTAssertEqual(pair.1, index % 4 == 3 ? pair.0 : pair.0 * 1.75, accuracy: 0.00001)
    }
    XCTAssertEqual(try Data(contentsOf: raw), try data("source", "dng"))
  }

  func testIncompleteSavedEditCannotFallBackToOriginalNativePixels() async throws {
    let (raw, xml) = try stage()
    let model = try XMPParser.parse(xml).0
    try FileManager.default.removeItem(
      at: raw.deletingLastPathComponent().appendingPathComponent(".maple/inpaint"))
    do {
      _ = try await NativeDetailRenderer().render(
        asset: AssetRef(url: raw), sourceRect: CGRect(x: 0, y: 0, width: 8, height: 4),
        model: model, aeGain: 1)
      XCTFail("An incomplete accepted stack cannot return original native pixels")
    } catch { XCTAssertTrue(error is PipelineError) }
  }

  @MainActor
  func testEditorSchedulerPublishesAcceptedNativeDetailAtOneToOneZoom() async throws {
    let (raw, xml) = try stage()
    var model = try XMPParser.parse(xml).0
    model.profile = .neutral
    model.autoExposure = .off
    let session = EditSession(asset: AssetRef(url: raw), model: model)
    session.nativeImageSize = CGSize(width: 16, height: 8)
    session.updateTileVisibleRegion(viewport: CGRect(x: 2, y: 1, width: 8, height: 4), zoom: 1)
    let deadline = Date().addingTimeInterval(15)
    while session.nativeDetailPreview == nil, Date() < deadline {
      try await Task.sleep(for: .milliseconds(50))
    }
    let detail = try XCTUnwrap(session.nativeDetailPreview)
    XCTAssertTrue(session.nativeDetailSourceRect.contains(CGRect(x: 2, y: 1, width: 8, height: 4)))
    XCTAssertEqual(detail.extent.size, session.nativeDetailSourceRect.size)
    XCTAssertNil(session.renderError)
    await session.releaseTransientMemory()
    XCTAssertEqual(try Data(contentsOf: raw), try data("source", "dng"))
  }
}
