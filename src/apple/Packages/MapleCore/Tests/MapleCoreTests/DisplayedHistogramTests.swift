import CoreImage
import Foundation
import QuartzCore
import XCTest

@testable import MapleCore

@MainActor
final class DisplayedHistogramTests: XCTestCase {
  func testCPUPreviewSamplingIsBounded() async throws {
    let image = CIImage(color: CIColor(red: 0.5, green: 0.5, blue: 0.5))
      .cropped(to: CGRect(x: 0, y: 0, width: 2048, height: 1536))
    let result = try await LocalHistogram.displayedImage(
      image, context: CIContext(), colorSpace: .srgb)
    XCTAssertEqual(result.r.reduce(0, +), 512 * 384)
    XCTAssertEqual(result.r, result.g)
    XCTAssertEqual(result.g, result.b)
  }

  func testCPUHistogramUsesCroppedPreviewWithoutReadingOriginal() async throws {
    let asset = AssetRef(displayName: "unreadable-original", hintExtension: "dng") {
      XCTFail("A live histogram must not load original bytes")
      throw PipelineError.noByteSource
    }
    let session = EditSession(asset: asset)
    session.renderedPreview = Self.splitImage().cropped(
      to: CGRect(x: 16, y: 0, width: 16, height: 16))
    session.previewIsFullRender = true
    session.histogramState.framePresented()
    let resultValue = try await session.histogramForCurrentPreview()
    let result = try XCTUnwrap(resultValue)
    XCTAssertEqual(result.b[255], 256)
    XCTAssertEqual(result.r[0], 256)
    XCTAssertEqual(result.g[0], 256)
    XCTAssertEqual(result.r.reduce(0, +), 256)
  }

  func testNoCanvasFrameDoesNotStartADecode() async throws {
    let asset = AssetRef(displayName: "not-yet-open", hintExtension: "dng") {
      XCTFail("Waiting for the canvas must not start a second RAW decode")
      throw PipelineError.noByteSource
    }
    let session = EditSession(asset: asset)
    let histogram = try await session.histogramForCurrentPreview()
    XCTAssertNil(histogram)
  }

  func testGPUHistogramMatchesPresentedBytesAndSurvivesPreviewReadback() async throws {
    let savedSpace = UserDefaults.standard.object(forKey: CanvasColorSpace.defaultsKey)
    UserDefaults.standard.set(CanvasColorSpace.srgb.rawValue, forKey: CanvasColorSpace.defaultsKey)
    defer {
      if let savedSpace {
        UserDefaults.standard.set(savedSpace, forKey: CanvasColorSpace.defaultsKey)
      } else {
        UserDefaults.standard.removeObject(forKey: CanvasColorSpace.defaultsKey)
      }
    }
    let driver = GpuLiveDriver()
    let layer = CAMetalLayer()
    layer.bounds = CGRect(x: 0, y: 0, width: 64, height: 32)
    driver.register(layer: layer)
    let pixels: [Float] = (0..<64 * 32).flatMap { i in
      let x = Float(i % 64) / 64
      return [x * 0.6 + 0.02, x * 0.2 + 0.01, 0.03, 1]
    }
    try await driver.open(
      width: 64, height: 32,
      identity: .init(decodeGeneration: 1, crop: .identity)
    ) { pixels }
    let empty = try await driver.histogramForCurrentFrame()
    XCTAssertNil(empty, "An unpresented session must not invent a histogram")
    var model = AdjustmentModel.default
    model.profile = .neutral
    model.exposure = 0.7
    var presentError: Error?
    await driver.present(model: model, asShotCCT: 6500, asShotTint: 0) { presentError = $0 }
    XCTAssertNil(presentError)
    let asset = AssetRef(displayName: "GPU preview", hintExtension: "png") {
      XCTFail("GPU histogram must not load the original")
      throw PipelineError.noByteSource
    }
    let session = EditSession(asset: asset, model: model)
    session.gpuLiveDriver = driver
    session.gpuFramePresented = true
    session.histogramState.framePresented()
    let actualValue = try await session.histogramForCurrentPreview()
    let actual = try XCTUnwrap(actualValue)
    let frameValue = await driver.renderCurrentFrameBytes(
      model: model, asShotCCT: 6500, asShotTint: 0)
    let frame = try XCTUnwrap(frameValue)
    var expected = [[Int]](repeating: [Int](repeating: 0, count: 256), count: 3)
    for i in stride(from: 0, to: frame.bytes.count, by: 3) {
      for c in 0..<3 { expected[c][Int(frame.bytes[i + c])] += 1 }
    }
    XCTAssertEqual(actual.r, expected[0])
    XCTAssertEqual(actual.g, expected[1])
    XCTAssertEqual(actual.b, expected[2])
    // A separate cache/export readback must not replace the displayed statistics.
    var other = model
    other.exposure = -2
    _ = await driver.renderCurrentFrameBytes(model: other, asShotCCT: 6500, asShotTint: 0)
    let preserved = try await driver.histogramForCurrentFrame()
    XCTAssertEqual(preserved?.r, actual.r)
    UserDefaults.standard.set(
      CanvasColorSpace.displayP3.rawValue, forKey: CanvasColorSpace.defaultsKey)
    await driver.present(model: model, asShotCCT: 6500, asShotTint: 0) { presentError = $0 }
    XCTAssertNil(presentError)
    let p3 = try await driver.histogramForCurrentFrame()
    XCTAssertNotEqual(p3?.r, actual.r, "The histogram must follow the canvas primaries")
    // Re-present a changed exposure on the same upload.
    await driver.present(model: other, asShotCCT: 6500, asShotTint: 0) { presentError = $0 }
    let changed = try await driver.histogramForCurrentFrame()
    XCTAssertNotEqual(changed?.r, p3?.r)
    await driver.closeSession()
    withExtendedLifetime(layer) {}
  }

  private static func splitImage() -> CIImage {
    let bytes: [UInt8] = (0..<32 * 16).flatMap { i in
      i % 32 < 16 ? [255, 0, 0, 255] : [0, 0, 255, 255]
    }
    return CIImage(
      bitmapData: Data(bytes), bytesPerRow: 32 * 4,
      size: CGSize(width: 32, height: 16), format: .RGBA8,
      colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
  }
}
