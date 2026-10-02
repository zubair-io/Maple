import CoreImage
import Foundation
import ImageIO
import XCTest

@testable import MapleCore

@MainActor
final class NativeFloatExportTests: XCTestCase {
  private func fixture(_ name: String, _ ext: String) throws -> Data {
    let url = try XCTUnwrap(
      Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "removal/calibration"))
    return try Data(contentsOf: url)
  }

  private func stage() throws -> (URL, URL, AdjustmentModel, Data) {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "float-export")
    let raw = directory.appendingPathComponent("photo.dng")
    let source = try fixture("source", "dng")
    try source.write(to: raw)
    let assets = directory.appendingPathComponent(".maple/inpaint")
    try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
    for (name, ext, suffix) in [("mask", "mimf", "mask"), ("patch", "f16", "f16")] {
      let data = try fixture(name, ext)
      let digest = String(try RemovalBridge.digest(data).dropFirst(7))
      try data.write(to: assets.appendingPathComponent("\(digest).\(suffix)"))
    }
    return (directory, raw, try XMPParser.parse(data: fixture("saved", "xmp")).0, source)
  }

  private func assertSharedPixels(_ image: CIImage, reference: MapleImageData) {
    XCTAssertEqual(Int(image.extent.width), reference.width)
    XCTAssertEqual(Int(image.extent.height), reference.height)
    var rgba = [UInt8](repeating: 0, count: reference.width * reference.height * 4)
    CIContext().render(
      image, toBitmap: &rgba, rowBytes: reference.width * 4,
      bounds: image.extent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    let maximum =
      reference.pixels.indices.map { i in
        abs(Int(reference.pixels[i]) - Int(rgba[i / 3 * 4 + i % 3]))
      }.max() ?? 0
    XCTAssertLessThanOrEqual(maximum, 1)
  }

  func testFullSessionAppliesSavedCropExactlyOnceAndDeliversSharedPNG() async throws {
    let (directory, raw, saved, original) = try stage()
    defer { try? FileManager.default.removeItem(at: directory) }
    for accepted in [false, true] {
      var model = saved
      if !accepted { model.inpaintRemovals = nil }
      model.crop = Crop(top: 0.25, left: 0.25, bottom: 0.75, right: 0.75)
      let xmp = SidecarPath.sidecarURL(for: raw)
      let xml = XMPSerializer.serialize(model: model, culling: CullingState())
      try xml.write(to: xmp, atomically: true, encoding: .utf8)
      let reference = try PipelineRenderer.render(
        rawPath: raw, xmpPath: xmp,
        quality: AmazeFlag.isEnabled ? .amaze : .full)
      XCTAssertEqual([reference.width, reference.height], [8, 4])
      let session = EditSession(asset: AssetRef(url: raw), model: model)
      let png = try await MapleExporter.exportData(session: session, options: .init(format: .png))
      assertSharedPixels(try XCTUnwrap(CIImage(data: png)), reference: reference)
      await session.releaseTransientMemory()
      XCTAssertEqual(try Data(contentsOf: xmp), Data(xml.utf8))
    }
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }

  func testNativeFilmFloatOutputKeepsPrecisionAndProducesTrue16BitTIFF() async throws {
    let (directory, raw, saved, original) = try stage()
    defer { try? FileManager.default.removeItem(at: directory) }
    var model = saved
    model.filmStrength = 100
    let xmp = SidecarPath.sidecarURL(for: raw)
    try XMPSerializer.serialize(model: model, culling: CullingState()).write(
      to: xmp, atomically: true, encoding: .utf8)
    // A controlled finite two-node linear RGB look through the real shared stage.
    let lut = (
      data: (0..<8).flatMap { i in
        [Float(i & 1), Float((i >> 1) & 1), Float((i >> 2) & 1)]
      }, size: 2, key: UInt32(1)
    )
    let reference = try PipelineRenderer.render(
      rawPath: raw, xmpPath: xmp, quality: .amaze, filmLut: lut)
    let image = try await RenderActor(pipeline: ImageEditPipeline()).renderForExport(
      asset: AssetRef(url: raw), model: model, asShot: nil, qualityOverride: .amaze,
      targetPrimariesOverride: .srgb, filmLut: lut)
    assertSharedPixels(image, reference: reference)
    var rgba = [Float](repeating: 0, count: reference.width * reference.height * 4)
    CIContext(options: [.workingFormat: CIFormat.RGBAf]).render(
      image, toBitmap: &rgba, rowBytes: reference.width * 16, bounds: image.extent,
      format: .RGBAf, colorSpace: CGColorSpace(name: CGColorSpace.extendedSRGB)!)
    XCTAssertTrue(
      rgba.enumerated().contains { i, v in
        i % 4 != 3 && abs(v * 255 - (v * 255).rounded()) > 0.05
      }, "Native film output must not be promoted from RGB8")
    let tiff = try await MapleExporter.encodeOffMainActor(image, options: .init(format: .tiff16))
    let source = try XCTUnwrap(CGImageSourceCreateWithData(tiff as CFData, nil))
    let delivered = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    XCTAssertEqual(delivered.bitsPerComponent, 16)
    XCTAssertEqual([delivered.width, delivered.height], [reference.width, reference.height])
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }

  func testImportedWBAbsenceAndPartialPairsExportAgainstOriginalSidecar() async throws {
    let (directory, raw, _, original) = try stage()
    defer { try? FileManager.default.removeItem(at: directory) }
    let sidecar = SidecarPath.sidecarURL(for: raw)
    for attrs in [
      "", #"crs:Temperature="6500""#, #"crs:Tint="0""#,
      #"crs:Temperature="6500" crs:Tint="0""#, #"crs:WhiteBalance="Daylight""#,
    ] {
      let xml = """
        <x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" \(attrs)/></rdf:RDF></x:xmpmeta>
        """
      try Data(xml.utf8).write(to: sidecar)
      let model = try XMPParser.parse(xml).0
      let reference = try PipelineRenderer.render(
        rawPath: raw, xmpPath: sidecar, quality: AmazeFlag.isEnabled ? .amaze : .full)
      let session = EditSession(asset: AssetRef(url: raw), model: model)
      await session.loadSidecar()
      XCTAssertEqual(session.model.temperatureSeen, model.temperatureSeen)
      XCTAssertEqual(session.model.tintSeen, model.tintSeen)
      let bytes = try await MapleExporter.exportData(session: session, options: .init(format: .png))
      assertSharedPixels(try XCTUnwrap(CIImage(data: bytes)), reference: reference)
      await session.releaseTransientMemory()
      XCTAssertEqual(try Data(contentsOf: sidecar), Data(xml.utf8))
    }
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }
}
