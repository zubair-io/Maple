import CoreImage
import Foundation
import XCTest

@testable import MapleCore

final class ThumbnailLoaderRawSidecarTests: XCTestCase {
  private let fm = FileManager.default
  private var root: URL!
  private var raw: URL!

  override func setUpWithError() throws {
    root = fm.temporaryDirectory.appendingPathComponent("raw-derivative-\(UUID())")
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    raw = root.appendingPathComponent("photo-\(UUID()).dng")
    try fm.copyItem(
      at: try XCTUnwrap(rawDerivativeFixture("test-fixtures/batch-transfer/source.dng")), to: raw)
  }

  override func tearDownWithError() throws {
    try fm.removeItem(at: root)
  }

  @discardableResult
  private func writeSidecar(_ model: AdjustmentModel) throws -> Data {
    let xml = Data(XMPSerializer.serialize(model: model, culling: CullingState()).utf8)
    try xml.write(to: SidecarPath.sidecarURL(for: raw))
    return xml
  }

  private func decodedPixels(_ bytes: Data) throws -> Data {
    let image = try XCTUnwrap(CIImage(data: bytes))
    let width = Int(image.extent.width)
    let height = Int(image.extent.height)
    var pixels = Data(count: width * height * 4)
    pixels.withUnsafeMutableBytes {
      CIContext().render(
        image, toBitmap: $0.baseAddress!, rowBytes: width * 4,
        bounds: image.extent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    }
    return pixels
  }

  private func expected(_ model: AdjustmentModel, quality: CGFloat, film: Bool = false) throws
    -> Data
  {
    // Native RAW+XMP output is the oracle. This tiny fixture needs no resize,
    // so the expected encode bypasses the loader's scaling helper.
    let lut = film ? FilmLutStore(bundle: .module).lattice(for: model.filmLook) : nil
    let image = try PipelineRenderer.render(
      rawPath: raw, xmpPath: SidecarPath.sidecarURL(for: raw),
      quality: .preview, filmLut: lut)
    let provider = try XCTUnwrap(CGDataProvider(data: image.pixels as CFData))
    let cg = try XCTUnwrap(
      CGImage(
        width: image.width, height: image.height,
        bitsPerComponent: 8, bitsPerPixel: 24, bytesPerRow: image.width * 3,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
        provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent))
    return try XCTUnwrap(
      ThumbnailEncoder.encode(CIImage(cgImage: cg), ctx: CIContext(), quality: quality))
  }

  func testColdThumbnailAndDisplayPreviewMatchAuthoredRawPixelsAndPreserveFiles() async throws {
    let original = try Data(contentsOf: raw)
    let model = AdjustmentModel(exposure: -2, highlights: -65)
    let xml = try writeSidecar(model)
    let thumbExpected = try expected(model, quality: MapleThumbCacheKey.onShareThumbAVIFQuality)
    let previewExpected = try expected(model, quality: ThumbnailLoader.displayPreviewAvifQuality)
    await ThumbnailDiskCache.shared.configure(folderURL: root)
    let loader = ThumbnailLoader()
    let thumbResult = await loader.load(for: raw)
    let thumb = try XCTUnwrap(thumbResult)
    XCTAssertEqual(try decodedPixels(thumb), try decodedPixels(thumbExpected))
    let thumbPath = MapleSidecarPaths.thumbURL(for: raw)
    XCTAssertEqual(try Data(contentsOf: thumbPath), thumb)
    let thumbMtime = try fm.attributesOfItem(atPath: thumbPath.path)[.modificationDate] as? Date
    let warm = await loader.load(for: raw)
    XCTAssertEqual(warm, thumb)
    XCTAssertEqual(
      try fm.attributesOfItem(atPath: thumbPath.path)[.modificationDate] as? Date, thumbMtime)

    let previewResult = await loader.loadDisplayPreview(for: AssetRef(url: raw))
    let preview = try XCTUnwrap(previewResult)
    XCTAssertEqual(try decodedPixels(preview), try decodedPixels(previewExpected))
    let previewPath = MapleSidecarPaths.previewURL(for: raw)
    XCTAssertEqual(try Data(contentsOf: previewPath), preview)
    let previewMtime = try fm.attributesOfItem(atPath: previewPath.path)[.modificationDate] as? Date
    let warmPreview = await loader.loadDisplayPreview(for: AssetRef(url: raw))
    XCTAssertEqual(warmPreview, preview)
    XCTAssertEqual(
      try fm.attributesOfItem(atPath: previewPath.path)[.modificationDate] as? Date, previewMtime)
    try fm.removeItem(at: previewPath)
    let regeneratedResult = await loader.loadDisplayPreview(for: AssetRef(url: raw))
    let regenerated = try XCTUnwrap(regeneratedResult)
    XCTAssertEqual(try decodedPixels(regenerated), try decodedPixels(previewExpected))
    XCTAssertEqual(try Data(contentsOf: raw), original)
    XCTAssertEqual(try Data(contentsOf: SidecarPath.sidecarURL(for: raw)), xml)

    // An independent native render with no XMP must be visibly different
    // in pixel values, so this assertion cannot pass with camera/default pixels.
    let unedited = try PipelineRenderer.render(rawPath: raw, quality: .preview)
    let edited = try PipelineRenderer.render(
      rawPath: raw, xmpPath: SidecarPath.sidecarURL(for: raw), quality: .preview)
    XCTAssertNotEqual(edited.pixels, unedited.pixels)
  }

  func testSelectedFilmLookIsAppliedDuringColdRegeneration() throws {
    let model = AdjustmentModel(exposure: -1, filmLook: "test_lut", filmStrength: 100)
    try writeSidecar(model)
    let result = try XCTUnwrap(
      ThumbnailLoader.renderRawSidecarDerivative(
        at: raw,
        targetLongEdge: 512, quality: 0.55, filmBundle: .module))
    XCTAssertEqual(
      try decodedPixels(result), try decodedPixels(expected(model, quality: 0.55, film: true)))
    XCTAssertNotEqual(try decodedPixels(result), try decodedPixels(expected(model, quality: 0.55)))
  }

  func testMalformedAndUnreadableSidecarsNeverPublishCameraOriginals() async throws {
    await ThumbnailDiskCache.shared.configure(folderURL: root)
    for unreadable in [false, true] {
      let sidecar = SidecarPath.sidecarURL(for: raw)
      if unreadable {
        try fm.removeItem(at: sidecar)
        try fm.createDirectory(at: sidecar, withIntermediateDirectories: true)
      } else {
        try Data("<x:xmpmeta><rdf:RDF>".utf8).write(to: sidecar)
      }
      let loader = ThumbnailLoader()
      let thumb = await loader.load(for: raw)
      let preview = await loader.loadDisplayPreview(for: AssetRef(url: raw))
      XCTAssertNil(thumb)
      XCTAssertNil(preview)
      XCTAssertFalse(fm.fileExists(atPath: MapleSidecarPaths.thumbURL(for: raw).path))
      XCTAssertFalse(fm.fileExists(atPath: MapleSidecarPaths.previewURL(for: raw).path))
    }
  }

  func testMissingSidecarKeepsTheEmbeddedPathAvailableAndFailedRawDevelopThrows() throws {
    XCTAssertNil(
      try ThumbnailLoader.renderRawSidecarDerivative(at: raw, targetLongEdge: 512, quality: 0.55))
    try writeSidecar(AdjustmentModel(exposure: -1))
    try Data("invalid RAW".utf8).write(to: raw)
    XCTAssertThrowsError(
      try ThumbnailLoader.renderRawSidecarDerivative(at: raw, targetLongEdge: 512, quality: 0.55))
  }
}

final class ThumbnailLoaderRawCameraTierTests: XCTestCase {
  func testCameraRawRegenerationUsesTheSharedThumbnailAndDisplayTierSizes() async throws {
    guard let camera = rawDerivativeFixture("test-fixtures/raws/test_0017.dng") else {
      throw XCTSkip(
        "Camera RAW fixture unavailable; committed sensor fixture still covers XMP pixels")
    }
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent("raw-camera-tier-\(UUID())")
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: root) }
    let raw = root.appendingPathComponent("photo-\(UUID()).dng")
    try fm.copyItem(at: camera, to: raw)
    let xml = XMPSerializer.serialize(
      model: AdjustmentModel(exposure: -1, highlights: -65), culling: CullingState())
    try Data(xml.utf8).write(to: SidecarPath.sidecarURL(for: raw))
    await ThumbnailDiskCache.shared.configure(folderURL: root)
    let loader = ThumbnailLoader()
    let thumbnailResult = await loader.load(for: raw)
    let thumbnail = try XCTUnwrap(thumbnailResult)
    let thumbImage = try XCTUnwrap(CIImage(data: thumbnail))
    XCTAssertEqual(max(thumbImage.extent.width, thumbImage.extent.height), 512)
    let previewResult = await loader.loadDisplayPreview(for: AssetRef(url: raw))
    let preview = try XCTUnwrap(previewResult)
    let previewImage = try XCTUnwrap(CIImage(data: preview))
    XCTAssertEqual(max(previewImage.extent.width, previewImage.extent.height), 1280)
  }

}

// CI stages the committed sensor fixture beside Packages, while a checkout
// keeps it at the repository root. Locate the same real file in either layout.
private func rawDerivativeFixture(_ relativePath: String) -> URL? {
  var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  while directory.path != "/" {
    let candidate = directory.appendingPathComponent(relativePath)
    if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
    directory.deleteLastPathComponent()
  }
  return nil
}
