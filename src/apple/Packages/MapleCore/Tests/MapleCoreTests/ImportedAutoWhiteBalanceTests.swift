import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class ImportedAutoWhiteBalanceTests: XCTestCase {
  func testColdResolutionUsesTheSharedEstimatorAndPreservesOriginalIntent() async throws {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "imported-auto-wb-raw")
    defer { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("source.dng")
    try FileManager.default.copyItem(
      at: try PartialWhiteBalanceFixture.root().appendingPathComponent("source.dng"), to: raw)
    let bytes = try Data(contentsOf: raw)
    let sidecar = SidecarPath.sidecarURL(for: raw)
    let xml = """
      <x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:WhiteBalance="Auto"/></rdf:RDF></x:xmpmeta>
      """
    try xml.write(to: sidecar, atomically: true, encoding: .utf8)
    let expected = try await AutoAdjustments.compute(forRawAt: raw)
    let imported = try XMPParser.parse(xml).0
    let resolved = try await ImportedWhiteBalanceResolver.resolve(
      asset: AssetRef(url: raw), model: imported)
    XCTAssertEqual(resolved.temperature, expected.temperature)
    XCTAssertEqual(resolved.tint, expected.tint)
    XCTAssertEqual(resolved.exposure, imported.exposure)
    XCTAssertNotNil(resolved.partialWhiteBalance?.resolvedTarget)
    let cpu = PipelineRenderer.makeParams(from: resolved, wbFrame: nil)
    let gpu = PipelineRenderer.makeGpuLiveParams(from: resolved, wbFrame: nil)
    XCTAssertEqual(cpu.temperature, gpu.temperature)
    XCTAssertEqual(cpu.tint, gpu.tint)
    XCTAssertEqual(try Data(contentsOf: raw), bytes)
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), xml)
  }

  func testNameOnlyAutoSurvivesRealSidecarRoundTripAndUnrelatedEdits() throws {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "imported-auto-wb")
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("source.xmp")
    let xml = """
      <x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:WhiteBalance="Auto"/></rdf:RDF></x:xmpmeta>
      """
    try xml.write(to: path, atomically: true, encoding: .utf8)
    let imported = try XMPParser.parse(data: Data(contentsOf: path)).0
    XCTAssertEqual(imported.whiteBalancePreset, .auto)
    let intent = try XCTUnwrap(imported.partialWhiteBalance)
    XCTAssertNil(intent.temperature)
    XCTAssertNil(intent.tint)
    var edited = imported
    edited.exposure = 1.25
    try XMPSerializer.serialize(model: edited, culling: CullingState())
      .write(to: path, atomically: true, encoding: .utf8)
    let saved = try String(contentsOf: path, encoding: .utf8)
    XCTAssertTrue(saved.contains(#"crs:WhiteBalance="Auto""#))
    XCTAssertFalse(saved.contains("crs:Temperature="))
    XCTAssertFalse(saved.contains("crs:Tint="))
    XCTAssertEqual(try XMPParser.parse(saved).0.partialWhiteBalance, intent)

    let authored = xml.replacingOccurrences(
      of: #"crs:WhiteBalance="Auto""#,
      with: #"crs:WhiteBalance="Auto" crs:Temperature="6500" crs:Tint="0""#)
    let explicit = try XMPParser.parse(authored).0
    XCTAssertNil(explicit.partialWhiteBalance)
    XCTAssertEqual(explicit.temperature, 6500)
    XCTAssertEqual(explicit.tint, 0)
  }
}
