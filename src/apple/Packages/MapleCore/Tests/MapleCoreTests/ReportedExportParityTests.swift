import CoreImage
import Foundation
import ImageIO
import XCTest

@testable import MapleCore

/// The user-supplied RAW/XMP for #3357 stays in the gitignored fixture tree.
/// Every session operates on a fresh temporary copy, never on that source.
@MainActor
final class ReportedExportParityTests: XCTestCase {
  func testReportedPhotoLocalAndCloudExportAgree() async throws {
    let fixture = AutoProfileCanvasParityTests.fixtureDir("test-fixtures/raws/084A9984.CR2")
    let sidecar = fixture.deletingPathExtension().appendingPathExtension("xmp")
    guard FileManager.default.fileExists(atPath: fixture.path),
      FileManager.default.fileExists(atPath: sidecar.path)
    else { throw XCTSkip("084A9984.CR2 / XMP absent") }

    let directory = try SidecarContractIO.makeTempDirectory(prefix: "reported-export")
    defer { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent(fixture.lastPathComponent)
    let xmp = raw.deletingPathExtension().appendingPathExtension("xmp")
    try FileManager.default.copyItem(at: fixture, to: raw)
    try FileManager.default.copyItem(at: sidecar, to: xmp)
    let originalHash = try SidecarContractIO.sha256(of: raw)
    let sidecarBytes = try Data(contentsOf: xmp)
    let (model, _) = try XMPParser.parse(data: sidecarBytes)
    let size = try XCTUnwrap(ImageMetadataReader.readPixelSize(from: raw))
    let native = CGSize(width: size.width, height: size.height)
    let expectedSize = CropImageStage.croppedSize(model.crop, nativeSize: native)
    let results = FileManager.default.temporaryDirectory.appendingPathComponent(
      "maple-3357-results")
    try FileManager.default.createDirectory(at: results, withIntermediateDirectories: true)

    let local = try await export(raw: raw, remote: false, expectedSize: expectedSize)
    try local.write(to: results.appendingPathComponent("084A9984-fixed-local.jpg"))
    let cloud = try await export(raw: raw, remote: true, expectedSize: expectedSize)
    try cloud.write(to: results.appendingPathComponent("084A9984-fixed-cloud.jpg"))
    XCTAssertEqual(local, cloud, "The same RAW/XMP must export identically through either source")

    try await writeGPUPreview(raw: raw, model: model, native: native, results: results)
    XCTAssertEqual(try SidecarContractIO.sha256(of: raw), originalHash)
    XCTAssertEqual(try Data(contentsOf: xmp), sidecarBytes)
    print(
      "[3357] verified crop \(expectedSize.width)x\(expectedSize.height); artifacts: \(results.path)"
    )
  }

  private func export(raw: URL, remote: Bool, expectedSize: CGSize) async throws -> Data {
    let asset =
      remote
      ? AssetRef(
        displayName: raw.lastPathComponent, hintExtension: "cr2",
        bytesProvider: { try Data(contentsOf: raw) })
      : AssetRef(url: raw)
    let session = EditSession(
      asset: asset,
      remoteSidecarStore: remote ? XMPSidecarStore(rawURL: raw) : nil)
    await session.loadSidecar()
    let image = try await session.renderForExport()
    XCTAssertEqual(image.extent.width, expectedSize.width, accuracy: 2)
    XCTAssertEqual(image.extent.height, expectedSize.height, accuracy: 2)
    let scaled = MapleExporter.scaledImage(image, maxSide: 1600)
    return try MapleExporter.encodeImage(scaled, options: ExportOptions(format: .jpegSRGB))
  }

  /// Same GPU chain, fit, crop, and WB anchor used by the local canvas.
  /// The artifact supports a perceptual comparison with the actual export.
  private func writeGPUPreview(raw: URL, model: AdjustmentModel, native: CGSize, results: URL)
    async throws
  {
    let pipeline = ImageEditPipeline()
    let decodeResult = await pipeline.decodeSceneLinearSized(
      asset: AssetRef(url: raw), targetSize: CGSize(width: 1600, height: 1600),
      xmpPath: raw.deletingPathExtension().appendingPathExtension("xmp"),
      quality: .preview, profileOverride: model.profile, autoExposureOverride: model.autoExposure)
    let decode = try XCTUnwrap(decodeResult)
    let cropped = CropImageStage.apply(model.crop, to: decode.image, nativeSize: native)
    let floats = try XCTUnwrap(pipeline.sceneLinearFloats(from: cropped, targetSize: nil))
    let gpu = try GpuLiveSession(
      pixels: floats.pixels, width: floats.width, height: floats.height,
      noiseProfile: decode.noiseProfile, iso: decode.iso)
    await gpu.fitAutoProfile(rawPath: raw.path, quality: .preview)
    let frame = decode.wbFrame
    let rendered = try await gpu.renderToBuffer(
      model: model,
      asShotCCT: frame.map { Double($0.sceneCCT) },
      asShotTint: frame.map { Double($0.asShotTint) }, wbFrame: frame)
    let bytes = try XCTUnwrap(rendered)
    let provider = try XCTUnwrap(CGDataProvider(data: Data(bytes) as CFData))
    let cg = try XCTUnwrap(
      CGImage(
        width: floats.width, height: floats.height,
        bitsPerComponent: 8, bitsPerPixel: 24, bytesPerRow: floats.width * 3,
        space: CanvasColorSpace.current == .srgb
          ? CGColorSpace(name: CGColorSpace.sRGB)! : CGColorSpace(name: CGColorSpace.displayP3)!,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue), provider: provider,
        decode: nil, shouldInterpolate: true, intent: .defaultIntent))
    let png = try MapleExporter.encodeImage(
      CIImage(cgImage: cg), options: ExportOptions(format: .png))
    try png.write(to: results.appendingPathComponent("084A9984-local-gpu-preview.png"))
  }
}
