import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import MapleCore

@Suite struct PanoAutoCropRecordTests {
  private let crop = PanoAutoCrop(
    outputWidth: 1000, outputHeight: 400, x: 100, y: 40, width: 800, height: 320)

  private func pngData(width: Int, height: Int) throws -> Data {
    let context = try #require(
      CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
    context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.6, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let image = try #require(context.makeImage())
    let data = NSMutableData()
    let destination = try #require(
      CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    #expect(CGImageDestinationFinalize(destination))
    return data as Data
  }

  @Test func theSidecarCropsToTheRectangleAsNormalizedEdges() throws {
    let xml = try #require(PanoAutoCropRecord.sidecarXML(for: crop))
    let (model, _) = try XMPParser.parse(data: Data(xml.utf8))
    #expect(model.crop == Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9))
  }

  @Test func a360PanoramaKeepsItsWrappingAxisWhole() throws {
    let wrapped = PanoAutoCrop(
      outputWidth: 4096, outputHeight: 1024, x: 0, y: 64, width: 4096, height: 900)
    let xml = try #require(PanoAutoCropRecord.sidecarXML(for: wrapped))
    let (model, _) = try XMPParser.parse(data: Data(xml.utf8))
    #expect(model.crop.left == 0)
    #expect(model.crop.right == 1)
  }

  @Test func theWholeImageOrARectangleOutsideItIsNoCrop() {
    let whole = PanoAutoCrop(outputWidth: 100, outputHeight: 50, x: 0, y: 0, width: 100, height: 50)
    let outside = PanoAutoCrop(
      outputWidth: 100, outputHeight: 50, x: 60, y: 0, width: 80, height: 50)
    #expect(PanoAutoCropRecord.sidecarXML(for: whole) == nil)
    #expect(PanoAutoCropRecord.sidecarXML(for: outside) == nil)
  }

  @Test func theCrcMatchesThePngSpecification() {
    #expect(PanoAutoCropRecord.crc32(Data("IEND".utf8)) == 0xAE42_6082)
  }

  @Test func theMarkKeepsThePixelsAndChangesTheBytes() throws {
    let original = try pngData(width: 32, height: 16)
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(
      "mark-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: url) }
    try original.write(to: url)

    try PanoAutoCropRecord.markPNG(at: url, with: crop)

    let marked = try Data(contentsOf: url)
    #expect(marked != original)
    #expect(marked.suffix(12) == Data([0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]))
    #expect(marked.range(of: Data("Maple Auto Crop\0100,40,800,320".utf8)) != nil)
    let source = try #require(CGImageSourceCreateWithData(marked as CFData, nil))
    let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
    #expect((image.width, image.height) == (32, 16))
  }

  @Test func recordingWritesTheSidecarBesideThePanoramaAndNeverReplacesOne() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "record-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let panorama = directory.appendingPathComponent("panorama-1.png")
    try pngData(width: 32, height: 16).write(to: panorama)

    try PanoAutoCropRecord.record(crop, forPanorama: panorama)

    let sidecar = directory.appendingPathComponent("panorama-1.xmp")
    #expect(FileManager.default.fileExists(atPath: sidecar.path))
    #expect(throws: (any Error).self) {
      try PanoAutoCropRecord.record(crop, forPanorama: panorama)
    }
  }

  @Test func thePreviewIsFramedToTheRectangleOnlyWhileAutoCropIsOn() throws {
    let edges = PanoEdgesReport(
      boundaryWarpStatus: .off, boundaryWarpApplied: 0,
      crop: PanoAutoCrop(outputWidth: 1000, outputHeight: 400, x: 100, y: 40, width: 800, height: 320))
    let context = try #require(
      CGContext(
        data: nil, width: 500, height: 200, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
    let image = try #require(context.makeImage())
    let preview = PanoPreview(
      image: image, alignment: PanoAlignment(json: Data()), alignmentOutcome: .solved, edges: edges)

    let framed = preview.displayImage(autoCrop: true)
    #expect((framed.width, framed.height) == (400, 160))
    let whole = preview.displayImage(autoCrop: false)
    #expect((whole.width, whole.height) == (500, 200))
  }
}
