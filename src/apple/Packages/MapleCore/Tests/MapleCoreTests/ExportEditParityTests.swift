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

  func testFastExportReusesDecodedImageWithoutInvokingBytesProvider() async throws {
    final class Counter: @unchecked Sendable {
      private let lock = NSLock()
      private var count = 0
      func increment() {
        lock.lock()
        defer { lock.unlock() }
        count += 1
      }
      var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
      }
    }

    let counter = Counter()
    let dummyImage = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 256, height: 256))
    let asset = AssetRef(
      displayName: "test.cr2",
      hintExtension: "cr2",
      bytesProvider: {
        counter.increment()
        return Data()
      }
    )
    let rawSource = RawRenderSource(asset: asset)
    // In an EditSession, the remote RAW is staged once during initial decode:
    _ = try await rawSource.url(for: asset)
    XCTAssertEqual(counter.value, 1, "Initial session decode stages the remote RAW once")

    let actor = RenderActor(pipeline: ImageEditPipeline(), rawRenderSource: rawSource)
    var model = AdjustmentModel.default
    model.exposure = 0.5
    await actor._testSeedDecodedCache(
      asset: asset,
      decoded: dummyImage,
      rawResolution: CGSize(width: 256, height: 256),
      bakedModel: RawCoreBridge.stripAppleGPUStages(model),
      profile: model.profile,
      autoExposure: model.autoExposure
    )

    let targetSize = CGSize(width: 256, height: 256)
    let exported = try await actor.renderForExport(
      asset: asset,
      model: model,
      asShot: nil,
      targetSize: targetSize,
      qualityOverride: .preview
    )

    XCTAssertEqual(
      counter.value, 1,
      "Fast export must reuse cached decode and staged file without invoking bytesProvider again")
    XCTAssertEqual(exported.extent.size, targetSize)
  }

  func testExportThrowsWhenAutoProfileCannotBeLoaded() async throws {
    struct TestFetchError: Error, Equatable {}
    let asset = AssetRef(
      displayName: "offline.cr2",
      hintExtension: "cr2",
      bytesProvider: { throw TestFetchError() }
    )
    let actor = RenderActor(pipeline: ImageEditPipeline())
    var model = AdjustmentModel.default
    model.profile = .auto
    do {
      _ = try await actor.renderForExport(
        asset: asset,
        model: model,
        asShot: nil,
        targetSize: CGSize(width: 256, height: 256),
        qualityOverride: .preview
      )
      XCTFail("Export must throw when Auto Profile cannot stage/fetch")
    } catch {
      // Expected to throw rather than silently outputting wrong-color render (#3627)
    }
  }

  func testFastExportReusesDecodedImageForNonRawWithoutReDecoding() async throws {
    final class Counter: @unchecked Sendable {
      private let lock = NSLock()
      private var count = 0
      func increment() {
        lock.lock()
        defer { lock.unlock() }
        count += 1
      }
      var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
      }
    }

    let counter = Counter()
    let dummyImage = CIImage(color: .red).cropped(to: CGRect(x: 0, y: 0, width: 128, height: 128))
    let asset = AssetRef(
      displayName: "photo.jpg",
      hintExtension: "jpg",
      bytesProvider: {
        counter.increment()
        return Data()
      }
    )
    let actor = RenderActor(pipeline: ImageEditPipeline())
    let model = AdjustmentModel.default
    await actor._testSeedDecodedCache(
      asset: asset,
      decoded: dummyImage,
      rawResolution: CGSize(width: 128, height: 128)
    )

    let targetSize = CGSize(width: 128, height: 128)
    let exported = try await actor.renderForExport(
      asset: asset,
      model: model,
      asShot: nil,
      targetSize: targetSize,
      qualityOverride: .preview
    )

    XCTAssertEqual(
      counter.value, 0,
      "Non-RAW fast export must reuse cached decode without invoking bytesProvider")
    XCTAssertEqual(exported.extent.size, targetSize)
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
