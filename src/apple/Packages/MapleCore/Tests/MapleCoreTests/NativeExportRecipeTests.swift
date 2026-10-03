import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import MapleCore

final class NativeExportRecipeTests: XCTestCase {
  func testStrictGeneratedRecipeRoundTripRetainsUnsupportedChoicesAndNullFields() async throws {
    var recipe = ExportRecipe.defaults
    recipe.format = "future-encoder"
    recipe.outputProfile = "future-profile"
    recipe.renderingIntent = "perceptual"
    recipe.metadataPolicy = "copy"
    recipe.watermark = "copyright"
    let bytes = try JSONEncoder().encode(recipe)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    XCTAssertEqual(Set(object.keys), Set(ExportRecipe.CodingKeys.allCases.map(\.rawValue)))
    XCTAssertTrue(object["directory"] is NSNull)
    XCTAssertEqual(try JSONDecoder().decode(ExportRecipe.self, from: bytes), recipe)
    XCTAssertThrowsError(try NativeExportRecipeBridge.validate(recipe))
    for mutation in ["unknown", "missing", "version"] {
      var changed = object
      if mutation == "unknown" { changed["extra"] = true }
      if mutation == "missing" { changed.removeValue(forKey: "quality") }
      if mutation == "version" { changed["schemaVersion"] = 99 }
      XCTAssertThrowsError(
        try JSONDecoder().decode(
          ExportRecipe.self,
          from: JSONSerialization.data(withJSONObject: changed)))
    }
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "native-recipes")
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = NativeExportRecipeStore(directory: directory)
    let value = SavedNativeExportRecipe(recipe: recipe)
    try await store.save(value)
    let values = try await store.list()
    XCTAssertEqual(values, [value])
    try await store.delete(value.id)
    let empty = try await store.list()
    XCTAssertTrue(empty.isEmpty)
  }

  func testSharedFilenameAndCapabilityErrors() throws {
    var recipe = ExportRecipe.defaults
    recipe.namingTemplate = "{original}-{n}-{date:YYYYMMDD}.{ext}"
    XCTAssertEqual(
      try NativeExportRecipeBridge.filename(recipe, stem: "Photo", capturedAt: nil, index: 4),
      "Photo-5-unknown-date.jpg")
    recipe.metadataPolicy = "copy"
    XCTAssertThrowsError(try NativeExportRecipeBridge.validate(recipe))
    recipe.metadataPolicy = "strip"
    recipe.maxLongEdge = 0
    XCTAssertThrowsError(try NativeExportRecipeBridge.validate(recipe))
  }

  func testRealMetadataCarriersAreStrippedAndSizeCapNeverUpscales() throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "native-export-metadata")
    defer { try? FileManager.default.removeItem(at: root) }
    let original = root.appendingPathComponent("source.jpg")
    let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
    let context = try XCTUnwrap(
      CGContext(
        data: nil, width: 32, height: 24,
        bitsPerComponent: 8, bytesPerRow: 128, space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(red: 0.4, green: 0.25, blue: 0.15, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: 32, height: 24))
    let image = try XCTUnwrap(context.makeImage())
    let destination = try XCTUnwrap(
      CGImageDestinationCreateWithURL(
        original as CFURL,
        UTType.jpeg.identifier as CFString, 1, nil))
    let metadata: [CFString: Any] = [
      kCGImagePropertyExifDictionary: [
        kCGImagePropertyExifDateTimeOriginal: "2026:10:03 12:00:00",
        kCGImagePropertyExifISOSpeedRatings: [400],
      ],
      kCGImagePropertyGPSDictionary: [
        kCGImagePropertyGPSLatitude: 25.0,
        kCGImagePropertyGPSLatitudeRef: "N", kCGImagePropertyGPSLongitude: 70.0,
        kCGImagePropertyGPSLongitudeRef: "W",
      ],
      kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFArtist: "Recipe test photographer"],
    ]
    CGImageDestinationAddImage(destination, image, metadata as CFDictionary)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    let before = try Data(contentsOf: original)
    let decoded = try XCTUnwrap(CGImageSourceCreateWithData(before as CFData, nil))
    let sourceProperties = try XCTUnwrap(
      CGImageSourceCopyPropertiesAtIndex(decoded, 0, nil) as? [String: Any])
    XCTAssertNotNil(sourceProperties[kCGImagePropertyGPSDictionary as String])
    XCTAssertNotNil(sourceProperties[kCGImagePropertyExifDictionary as String])
    var recipe = ExportRecipe(format: "png", quality: nil)
    let full = root.appendingPathComponent("full.tmp")
    try NativeExportRecipeBridge.render(
      source: original, xmp: NativeWorkflowControlFixture.input(),
      recipe: recipe, filmDirectory: nil, staging: full)
    recipe.maxLongEdge = 4096
    let capped = root.appendingPathComponent("large-cap.tmp")
    try NativeExportRecipeBridge.render(
      source: original, xmp: NativeWorkflowControlFixture.input(),
      recipe: recipe, filmDirectory: nil, staging: capped)
    XCTAssertEqual(try Data(contentsOf: full), try Data(contentsOf: capped))
    let result = try XCTUnwrap(CGImageSourceCreateWithURL(full as CFURL, nil))
    let properties = try XCTUnwrap(
      CGImageSourceCopyPropertiesAtIndex(result, 0, nil) as? [String: Any])
    XCTAssertEqual(properties[kCGImagePropertyPixelWidth as String] as? Int, 32)
    XCTAssertEqual(properties[kCGImagePropertyPixelHeight as String] as? Int, 24)
    XCTAssertNil(properties[kCGImagePropertyGPSDictionary as String])
    XCTAssertNil(properties[kCGImagePropertyExifDictionary as String])
    XCTAssertNotNil(properties[kCGImagePropertyProfileName as String])
    XCTAssertEqual(try Data(contentsOf: original), before)
  }

  func testEverySharedNativeEncoderAndProfilePreservesOriginalAndStripsMetadata() async throws {
    let fixture = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let sourceHash = try NativeExportStorage.hash(fixture.raw)
    for encoder in ExportRecipe.encoders {
      for profile in ExportRecipe.outputProfiles {
        var record = try NativeExportQueueFixture.record(
          fixture.raw, root: fixture.directory, stem: "output-\(encoder.format)-\(profile)")
        var recipe = record.recipe
        recipe.format = encoder.format
        recipe.bitDepth = encoder.bitDepth
        recipe.quality = ["jpeg", "avif", "webp"].contains(encoder.format) ? 90 : nil
        recipe.outputProfile = profile
        recipe.maxLongEdge = 32
        record = NativeExportQueueFixture.replacingRecipe(record, recipe)
        let queue = NativeExportQueue(
          directory: fixture.directory.appendingPathComponent("queue-\(encoder.format)-\(profile)"))
        try await queue.enqueue(record)
        try await queue.run()
        let loaded = try await queue.load()
        let result = try XCTUnwrap(loaded)
        XCTAssertEqual(result.successes, 1, result.items.first?.reason ?? "")
        let output = try XCTUnwrap(result.items.first?.output)
        let bytes = try Data(contentsOf: output)
        XCTAssertGreaterThan(bytes.count, 64)
        let image = try XCTUnwrap(CGImageSourceCreateWithData(bytes as CFData, nil))
        let properties = try XCTUnwrap(
          CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [String: Any])
        XCTAssertLessThanOrEqual(
          try XCTUnwrap(properties[kCGImagePropertyPixelWidth as String] as? Int), 32)
        let decoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(image, 0, nil))
        XCTAssertEqual(decoded.bitsPerComponent, Int(encoder.bitDepth))
        let space = try XCTUnwrap(decoded.colorSpace)
        var repository = URL(fileURLWithPath: #filePath)
        for _ in 0..<7 { repository.deleteLastPathComponent() }
        let goldenName = profile == "display-p3" ? "maple-display-p3-v2.icc" : "maple-srgb-v2.icc"
        let golden = try Data(
          contentsOf: repository.appendingPathComponent(
            "test-fixtures/export-recipes/\(goldenName)"))
        if encoder.format == "png" {
          // ImageIO expands the compressed PNG iCCP chunk; other carriers store the reviewed bytes verbatim.
          XCTAssertEqual(try XCTUnwrap(space.copyICCData()) as Data, golden)
        } else if ["webp", "avif"].contains(encoder.format), profile == "srgb" {
          // Canonical sRGB WebP/AVIF preserve their legacy carrier; P3 requires explicit tagging.
          XCTAssertNil(bytes.range(of: golden))
          if encoder.format == "webp" { XCTAssertNil(bytes.range(of: Data("ICCP".utf8))) }
        } else {
          XCTAssertNotNil(
            bytes.range(of: golden),
            "\(encoder.format)/\(profile) must embed the exact reviewed shared ICC.")
        }
        XCTAssertEqual(
          space.isWideGamutRGB, profile == "display-p3",
          "The platform decoder must achieve the declared output gamut.")
        XCTAssertNil(properties[kCGImagePropertyGPSDictionary as String])
        XCTAssertNil(properties[kCGImagePropertyExifDictionary as String])
        if encoder.format == "avif", profile == "display-p3" {
          let tag = Data("nclx".utf8)
          let range = bytes.range(of: tag)
          XCTAssertNotNil(range, "AVIF color signaling requires the shared #3580 correction.")
          if let range {
            let offset = range.upperBound
            let primaries = UInt16(bytes[offset]) << 8 | UInt16(bytes[offset + 1])
            XCTAssertEqual(
              primaries, profile == "display-p3" ? 12 : 1,
              "P3 AVIF requires the shared #3580 correction; do not qualify an old library.")
          }
        }
        XCTAssertEqual(try NativeExportStorage.hash(fixture.raw), sourceHash)
      }
    }
  }
}

enum NativeExportQueueFixture {
  static func record(
    _ raw: URL, root: URL, stem: String = "output", index: UInt64 = 0,
    xmp: String = NativeWorkflowControlFixture.input()
  ) throws -> NativeExportRecord {
    let destination = root.appendingPathComponent("outputs", isDirectory: true)
    try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
    let source = NativeExportSource(
      id: UUID().uuidString, url: raw, scopeURL: raw,
      bookmark: try NativeExportAccess.bookmark(raw), relativePath: "",
      originalHash: try XCTUnwrap(NativeExportStorage.hash(raw)),
      identity: try NativeExportStorage.identity(raw), ownedDirectory: nil)
    let target = NativeExportTarget(
      source: source, stem: stem, xmp: xmp, capturedAt: nil, index: index)
    let recipe = ExportRecipe(
      format: "png", quality: nil, destination: "directory",
      directory: destination.path, overwritePolicy: "error")
    return NativeExportRecord(
      version: 1, id: UUID(), recipe: recipe,
      destinationBookmark: try NativeExportAccess.bookmark(destination), originals: [source],
      filmDirectory: nil, filmHashes: [:], items: [NativeExportItem(target: target)])
  }
  static func replacingRecipe(_ record: NativeExportRecord, _ recipe: ExportRecipe)
    -> NativeExportRecord
  {
    NativeExportRecord(
      version: record.version, id: record.id, recipe: recipe,
      destinationBookmark: record.destinationBookmark, originals: record.originals,
      filmDirectory: record.filmDirectory, filmHashes: record.filmHashes, items: record.items)
  }
}
