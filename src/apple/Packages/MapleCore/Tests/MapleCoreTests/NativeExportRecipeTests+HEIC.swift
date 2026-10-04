import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import MapleCore

extension NativeExportRecipeTests {
  func testActualGeneratedHEICExportsCapturedEditsAndPreservesOriginal() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "native-generated-heic")
    defer { try? FileManager.default.removeItem(at: root) }
    let original = try NativeHEICRecipeFixture.source(root)
    let before = try Data(contentsOf: original)
    let sidecar = original.deletingPathExtension().appendingPathExtension("xmp")
    let xml = NativeWorkflowControlFixture.input(exposure: 0.75)
    try Data(xml.utf8).write(to: sidecar)
    let capturedXML = try String(contentsOf: sidecar, encoding: .utf8)
    let record = try NativeExportQueueFixture.record(original, root: root, xmp: capturedXML)
    let queue = NativeExportQueue(directory: root.appendingPathComponent("queue"))
    try await queue.enqueue(record)
    try await queue.run()
    let loaded = try await queue.load()
    let finished = try XCTUnwrap(loaded)
    XCTAssertEqual(finished.successes, 1, finished.items[0].reason ?? "")
    XCTAssertEqual(finished.originals, record.originals)
    XCTAssertEqual(try Data(contentsOf: original), before)
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), xml)
    guard let output = finished.items[0].output,
      FileManager.default.fileExists(atPath: output.path)
    else { return }
    let source = try XCTUnwrap(CGImageSourceCreateWithURL(output as CFURL, nil))
    let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    XCTAssertEqual(image.width, 48)
    XCTAssertEqual(image.height, 64)
    XCTAssertEqual(image.bitsPerComponent, 8)
    let pipeline = ImageEditPipeline()
    let decoded = await pipeline.decodeSceneLinearNonRaw(asset: AssetRef(url: original))
    let reference = pipeline.processSceneLinearNonRaw(
      decoded: try XCTUnwrap(decoded),
      model: try XMPParser.parse(data: Data(capturedXML.utf8)).0, targetPrimariesOverride: .srgb)
    let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
    let expectedImage = try XCTUnwrap(
      CIContext().createCGImage(
        reference, from: reference.extent,
        format: .RGBA8, colorSpace: space))
    let expected = NativeHEICRecipeFixture.pixels(expectedImage)
    let actual = NativeHEICRecipeFixture.pixels(image)
    XCTAssertEqual(actual.count, expected.count)
    XCTAssertLessThanOrEqual(
      zip(actual, expected).map { abs($0 - $1) }.max() ?? 0, 2.0 / 255.0,
      "Captured HEIC edits must match the existing independent native non-RAW export chain")
    let neutral = root.appendingPathComponent("without-exposure.png")
    try NativeExportRecipeBridge.render(
      source: original,
      xmp: NativeWorkflowControlFixture.input(exposure: 0), recipe: record.recipe,
      filmDirectory: nil, staging: neutral)
    XCTAssertNotEqual(try Data(contentsOf: output), try Data(contentsOf: neutral))
  }

  func testHEICTransportRetainsPixelsProfileDepthOrientationAndRemovesPrivateFiles() throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "native-heic-transport")
    defer { try? FileManager.default.removeItem(at: root) }
    let original = try NativeHEICRecipeFixture.source(root)
    let before = try Data(contentsOf: original)
    let source = try XCTUnwrap(CGImageSourceCreateWithURL(original as CFURL, nil))
    let originalImage = try XCTUnwrap(
      CGImageSourceCreateImageAtIndex(
        source, 0,
        [kCGImageSourceShouldAllowFloat: true] as CFDictionary))
    var privateInput: URL?
    try NativeExportHEICSource.withSource(original) { input in
      privateInput = input
      XCTAssertNotEqual(input, original)
      let transported = try XCTUnwrap(CGImageSourceCreateWithURL(input as CFURL, nil))
      let actual = try XCTUnwrap(
        CGImageSourceCreateImageAtIndex(
          transported, 0,
          [kCGImageSourceShouldAllowFloat: true] as CFDictionary))
      let properties = try XCTUnwrap(
        CGImageSourceCopyPropertiesAtIndex(transported, 0, nil)
          as? [CFString: Any])
      XCTAssertEqual((properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue, 6)
      XCTAssertEqual(actual.width, originalImage.width)
      XCTAssertEqual(actual.height, originalImage.height)
      XCTAssertEqual(actual.bitsPerComponent, originalImage.bitsPerComponent)
      XCTAssertEqual(actual.colorSpace?.copyICCData(), originalImage.colorSpace?.copyICCData())
      XCTAssertEqual(actual.bitsPerPixel, originalImage.bitsPerPixel)
      XCTAssertEqual(actual.bytesPerRow, originalImage.bytesPerRow)
      XCTAssertEqual(actual.bitmapInfo, originalImage.bitmapInfo)
      XCTAssertEqual(actual.dataProvider?.data, originalImage.dataProvider?.data)
      // HEIC-backed CGImage has a lazy CI path different from identical stored RGB.
      // Freeze both exact provider buffers before checking their managed-color interpretation.
      let expected = NativeHEICRecipeFixture.pixels(
        try NativeHEICRecipeFixture.copied(originalImage))
      let pixels = NativeHEICRecipeFixture.pixels(try NativeHEICRecipeFixture.copied(actual))
      XCTAssertEqual(pixels.count, expected.count)
      XCTAssertLessThanOrEqual(zip(pixels, expected).map { abs($0 - $1) }.max() ?? 0, 0.000001)
    }
    let input = try XCTUnwrap(privateInput)
    XCTAssertFalse(FileManager.default.fileExists(atPath: input.path))
    var workspace = input
    for _ in 0..<4 { workspace.deleteLastPathComponent() }
    XCTAssertFalse(FileManager.default.fileExists(atPath: workspace.path))
    XCTAssertEqual(try Data(contentsOf: original), before)
  }

  func testGeneratedTenBitHEICTransportPreservesFullPrecisionAndProfile() throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "native-ten-bit-heic")
    defer { try? FileManager.default.removeItem(at: root) }
    let original = try NativeHEICRecipeFixture.source(root, bits: 16)
    let before = try Data(contentsOf: original)
    let source = try XCTUnwrap(CGImageSourceCreateWithURL(original as CFURL, nil))
    let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    XCTAssertEqual(
      image.bitsPerComponent, 10, "Actual Apple encoder must produce a real ten-bit HEIC")
    try NativeExportHEICSource.withSource(original) { input in
      let transported = try XCTUnwrap(CGImageSourceCreateWithURL(input as CFURL, nil))
      let actual = try XCTUnwrap(CGImageSourceCreateImageAtIndex(transported, 0, nil))
      XCTAssertEqual(actual.bitsPerComponent, 16)
      XCTAssertEqual(actual.colorSpace?.copyICCData(), image.colorSpace?.copyICCData())
      let properties = try XCTUnwrap(
        CGImageSourceCopyPropertiesAtIndex(transported, 0, nil) as? [CFString: Any])
      XCTAssertEqual((properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue, 6)
      // Identical same-space sixteen-bit readout proves no eight-bit intermediate.
      XCTAssertEqual(
        try NativeHEICRecipeFixture.fullPrecision(image, space: image.colorSpace!),
        try NativeHEICRecipeFixture.fullPrecision(actual, space: image.colorSpace!))
    }
    XCTAssertEqual(try Data(contentsOf: original), before)
  }

  func testHEICFailedSharedRenderRemovesItsPrivateTransportAndRetainsOriginal() throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "native-heic-failed-render")
    defer { try? FileManager.default.removeItem(at: root) }
    let original = try NativeHEICRecipeFixture.source(root)
    let before = try Data(contentsOf: original)
    var model = AdjustmentModel.default
    model.contrast = 10  // Existing shared raster contract rejects RAW-only AgX contrast.
    let xml = XMPSerializer.serialize(model: model, culling: CullingState())
    var privateInput: URL?
    XCTAssertThrowsError(
      try NativeExportHEICSource.withSource(original) { input in
        privateInput = input
        try NativeExportRecipeBridge.render(
          source: input, xmp: xml,
          recipe: ExportRecipe(), filmDirectory: nil,
          staging: root.appendingPathComponent("failed.jpg"))
      }
    ) { error in XCTAssertTrue(error.localizedDescription.contains("requires a RAW source")) }
    let input = try XCTUnwrap(privateInput)
    XCTAssertFalse(FileManager.default.fileExists(atPath: input.path))
    var workspace = input
    for _ in 0..<4 { workspace.deleteLastPathComponent() }
    XCTAssertFalse(FileManager.default.fileExists(atPath: workspace.path))
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: root.appendingPathComponent("failed.jpg").path))
    XCTAssertEqual(try Data(contentsOf: original), before)
  }

}

/// Real Apple HEIC codec bytes with an explicit P3 profile and orientation.
/// This is a generated codec control, not a camera-origin fixture.
enum NativeHEICRecipeFixture {
  static func pixels(_ image: CGImage) -> [Float] {
    var values = [Float](repeating: 0, count: image.width * image.height * 4)
    values.withUnsafeMutableBytes { buffer in
      CIContext().render(
        CIImage(cgImage: image), toBitmap: buffer.baseAddress!,
        rowBytes: image.width * 4 * MemoryLayout<Float>.size,
        bounds: CGRect(x: 0, y: 0, width: image.width, height: image.height),
        format: .RGBAf, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
    }
    return values
  }
  static func copied(_ image: CGImage) throws -> CGImage {
    let data = try XCTUnwrap(image.dataProvider?.data)
    return try XCTUnwrap(
      CGImage(
        width: image.width, height: image.height,
        bitsPerComponent: image.bitsPerComponent, bitsPerPixel: image.bitsPerPixel,
        bytesPerRow: image.bytesPerRow, space: try XCTUnwrap(image.colorSpace),
        bitmapInfo: image.bitmapInfo, provider: try XCTUnwrap(CGDataProvider(data: data)),
        decode: nil, shouldInterpolate: false, intent: .defaultIntent))
  }
  static func fullPrecision(_ image: CGImage, space: CGColorSpace) throws -> Data {
    var values = Data(count: image.width * image.height * 8)
    try values.withUnsafeMutableBytes { buffer in
      let context = try XCTUnwrap(
        CGContext(
          data: buffer.baseAddress, width: image.width,
          height: image.height, bitsPerComponent: 16, bytesPerRow: image.width * 8,
          space: space,
          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            | CGBitmapInfo.byteOrder16Little.rawValue))
      context.setBlendMode(.copy)
      context.interpolationQuality = .none
      context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    }
    return values
  }
  static func source(_ root: URL, bits: Int = 8) throws -> URL {
    let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.displayP3))
    let context = try XCTUnwrap(
      CGContext(
        data: nil, width: 64, height: 48,
        bitsPerComponent: bits, bytesPerRow: 64 * 4 * (bits / 8), space: space,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
          | (bits == 16 ? CGBitmapInfo.byteOrder16Little.rawValue : 0)))
    context.setFillColor(red: 0.7, green: 0.12, blue: 0.3, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
    context.setFillColor(red: 0.1, green: 0.5, blue: 0.25, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: 24, height: 48))
    let image = try XCTUnwrap(context.makeImage())
    let source = root.appendingPathComponent("photo.heic")
    let destination = try XCTUnwrap(
      CGImageDestinationCreateWithURL(
        source as CFURL,
        UTType.heic.identifier as CFString, 1, nil), "Actual Apple HEIC encoder is required")
    CGImageDestinationAddImage(
      destination, image,
      [
        kCGImageDestinationLossyCompressionQuality: 1,
        kCGImagePropertyOrientation: 6,
        kCGImagePropertyExifDictionary: [
          kCGImagePropertyExifDateTimeOriginal: "2026:10:04 10:00:00"
        ],
      ] as CFDictionary)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    let decoded = try XCTUnwrap(CGImageSourceCreateWithURL(source as CFURL, nil))
    let properties = try XCTUnwrap(
      CGImageSourceCopyPropertiesAtIndex(decoded, 0, nil)
        as? [CFString: Any])
    XCTAssertEqual((properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue, 6)
    let actual = try XCTUnwrap(CGImageSourceCreateImageAtIndex(decoded, 0, nil))
    XCTAssertTrue(try XCTUnwrap(actual.colorSpace).isWideGamutRGB)
    return source
  }
}
