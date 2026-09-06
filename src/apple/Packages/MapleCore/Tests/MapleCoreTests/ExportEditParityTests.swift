import CoreImage
import ImageIO
import XCTest

@testable import MapleCore

@MainActor
final class ExportEditParityTests: XCTestCase {
  func testExportKeepsLiveCropAndExposureBeforeAutosave() async throws {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "export-edits")
    defer { try? FileManager.default.removeItem(at: directory) }
    let original = directory.appendingPathComponent("image.png")
    let originalBytes = try SidecarContractIO.makeSyntheticOriginal(at: original)
    let session = EditSession(asset: AssetRef(url: original))
    await session.loadSidecar()
    session.model.crop = Crop(top: 0.25, left: 0.25, bottom: 0.75, right: 0.75)
    session.model.exposure = 1
    session.cropEditingActive = true

    let image = try await session.renderForExport()
    XCTAssertEqual(image.extent, CGRect(x: 0, y: 0, width: 16, height: 16))
    let pipeline = ImageEditPipeline()
    let decode = await pipeline.decodeSceneLinearNonRaw(asset: session.asset, targetSize: nil)
    let decoded = try XCTUnwrap(decode)
    let expected = CropImageStage.apply(
      session.model.crop,
      to: pipeline.processSceneLinearNonRaw(decoded: decoded, model: session.model),
      nativeSize: decoded.extent.size)
    XCTAssertEqual(try pixels(image), try pixels(expected))
    for format in [ExportFileFormat.jpegSRGB, .jpegP3, .png, .tiff16] {
      let data = try MapleExporter.encodeImage(image, options: ExportOptions(format: format))
      let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
      let encoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
      XCTAssertEqual(encoded.width, 16)
      XCTAssertEqual(encoded.height, 16)
    }
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(try Data(contentsOf: original), originalBytes)
  }

  /// Real RAW with an embedded camera preview: omitting the Auto Profile
  /// cube must fail this comparison, even when crop/exposure fields are zero.
  func testRawExportIncludesAutoProfileForLocalAndBytesSources() async throws {
    let raw = AutoProfileCanvasParityTests.fixtureDir("test-fixtures/raws/test_0010.CR2")
    guard FileManager.default.fileExists(atPath: raw.path) else {
      throw XCTSkip("test_0010.CR2 absent")
    }
    let data = try Data(contentsOf: raw)
    let local = AssetRef(url: raw)
    let remote = AssetRef(
      displayName: raw.lastPathComponent, hintExtension: "cr2",
      bytesProvider: { data })
    let pipeline = ImageEditPipeline()
    let quality: PipelineRenderer.Quality = AmazeFlag.isEnabled ? .amaze : .full
    let decodedResult = await pipeline.decodeSceneLinear(
      asset: local, quality: quality, profileOverride: .auto,
      autoExposureOverride: .off)
    let decoded = try XCTUnwrap(decodedResult)
    let lut = await AutoProfileLUT.shared.filter(forRawAt: raw, profile: .auto, quality: quality)
    XCTAssertNotNil(lut)
    var model = AdjustmentModel.default
    model.autoExposure = .off
    model.exposure = 0.5
    let anchor = decoded.wbFrame.flatMap { frame -> ImageEditPipeline.AsShotWB? in
      guard frame.isPresent else { return nil }
      return .init(temperature: Double(frame.sceneCCT), tint: Double(frame.asShotTint))
    }
    if let anchor {
      model.temperature = anchor.temperature
      model.tint = anchor.tint
    }
    let expected = pipeline.processSceneLinear(
      decoded: decoded.image, model: model, asShot: anchor, profileLUT: lut,
      noiseProfile: decoded.noiseProfile, iso: decoded.iso, wbFrame: decoded.wbFrame)
    let expectedPixels = try pixels(expected)
    for asset in [local, remote] {
      let actor = RenderActor(pipeline: ImageEditPipeline())
      let actual = try await actor.renderForExport(asset: asset, model: model, asShot: anchor)
      let actualPixels = try pixels(actual)
      let meanError =
        zip(expectedPixels, actualPixels).reduce(0.0) {
          $0 + abs(Double($1.0) - Double($1.1))
        } / Double(expectedPixels.count)
      XCTAssertLessThan(meanError, 1.0, "Auto Profile must survive export for \(asset.displayName)")
    }
  }

  private func pixels(_ image: CIImage) throws -> [UInt8] {
    let scaled = MapleExporter.scaledImage(image, maxSide: 256)
    let width = Int(scaled.extent.width)
    let height = Int(scaled.extent.height)
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    let context = CIContext(options: [.cacheIntermediates: false])
    bytes.withUnsafeMutableBytes {
      context.render(
        scaled, toBitmap: $0.baseAddress!, rowBytes: width * 4,
        bounds: CGRect(x: 0, y: 0, width: width, height: height),
        format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    }
    return bytes
  }
}
