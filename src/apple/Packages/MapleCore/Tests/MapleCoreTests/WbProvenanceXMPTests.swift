import Foundation
import XCTest

@testable import MapleCore

/// White-balance provenance (#2434): `papp:WbSource` / `papp:WbSampleX` /
/// `papp:WbSampleY` / `papp:WbAlgorithmVersion` round-trip, omit at their
/// defaults, and never leak into a preset or a group paste.
final class WbProvenanceXMPTests: XCTestCase {

  func testSampledPairRoundTripsWithPointAndVersion() throws {
    var m = AdjustmentModel()
    m.wbSource = .sampled
    m.wbSampleX = 0.25
    m.wbSampleY = 0.75
    m.wbAlgorithmVersion = 1
    let xml = XMPSerializer.serialize(model: m, culling: CullingState())
    XCTAssertTrue(xml.contains(#"papp:WbSource="Sampled""#), xml)
    XCTAssertTrue(xml.contains(#"papp:WbSampleX="0.25""#), xml)
    XCTAssertTrue(xml.contains(#"papp:WbSampleY="0.75""#), xml)
    XCTAssertTrue(xml.contains(#"papp:WbAlgorithmVersion="1""#), xml)
    XCTAssertTrue(XMPParser.parsePassthrough(xml).unknownAttributes.isEmpty)
    let (m2, _) = try XMPParser.parse(xml)
    XCTAssertEqual(m2.wbSource, .sampled)
    XCTAssertEqual(m2.wbSampleX, 0.25)
    XCTAssertEqual(m2.wbSampleY, 0.75)
    XCTAssertEqual(m2.wbAlgorithmVersion, 1)
  }

  func testProvenanceIsOmittedAtDefaultAndPointOnlyTravelsWhenSampled() throws {
    let xml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
    for key in ["papp:WbSource", "papp:WbSampleX", "papp:WbSampleY", "papp:WbAlgorithmVersion"] {
      XCTAssertFalse(xml.contains(key), "\(key) must be omitted at the default")
    }
    var preset = AdjustmentModel()
    preset.wbSource = .preset
    preset.wbSampleX = 0.4
    let presetXml = XMPSerializer.serialize(model: preset, culling: CullingState())
    XCTAssertTrue(presetXml.contains(#"papp:WbSource="Preset""#))
    XCTAssertFalse(presetXml.contains("papp:WbSampleX"))

    // A `.sampled` source with no derivation version is a label a paste
    // carried, not provenance — `wbSource` is copyable, the point and the
    // version are not. Writing `0,0` would claim a sample that never
    // happened (#3309).
    var pasted = AdjustmentModel()
    pasted.wbSource = .sampled
    pasted.wbSampleX = 0.4
    pasted.wbSampleY = 0.6
    let pastedXml = XMPSerializer.serialize(model: pasted, culling: CullingState())
    XCTAssertTrue(pastedXml.contains(#"papp:WbSource="Sampled""#))
    XCTAssertFalse(pastedXml.contains("papp:WbSampleX"), pastedXml)
    XCTAssertFalse(pastedXml.contains("papp:WbAlgorithmVersion"), pastedXml)

    // Nor a version stranded on a source that cannot derive one.
    var manual = AdjustmentModel()
    manual.wbSource = .manual
    manual.wbAlgorithmVersion = 1
    let manualXml = XMPSerializer.serialize(model: manual, culling: CullingState())
    XCTAssertFalse(manualXml.contains("papp:WbAlgorithmVersion"), manualXml)
  }

  func testWbSourceParsesCaseInsensitivelyAndDropsUnknown() throws {
    let (auto, _) = try XMPParser.parse(xmp(attrs: #"papp:WbSource="auto""#))
    XCTAssertEqual(auto.wbSource, .auto)
    let (unknown, _) = try XMPParser.parse(xmp(attrs: #"papp:WbSource="Eyeballed""#))
    XCTAssertEqual(unknown.wbSource, .asShot)
  }

  func testPresetCaptureAndGroupMergeCarrySourceButNotThePoint() {
    var m = AdjustmentModel()
    m.wbSource = .sampled
    m.wbSampleX = 0.3
    m.wbSampleY = 0.6
    m.wbAlgorithmVersion = 1
    let fields = PresetAdjustments.captureFields(from: m)
    XCTAssertEqual(fields["wb_source"], .string("Sampled"))
    XCTAssertNil(fields["wb_sample_x"])
    XCTAssertNil(fields["wb_sample_y"])
    XCTAssertNil(fields["wb_algorithm_version"])

    let merged = AdjustmentGroupMerge.merged(
      AdjustmentModel(), applying: m, groups: [.whiteBalance])
    XCTAssertEqual(merged.wbSource, .sampled)
    XCTAssertEqual(merged.wbSampleX, 0, "the sample point is non-copyable")
    XCTAssertEqual(merged.wbAlgorithmVersion, 0, "the algorithm version is non-copyable")
  }

  func testRealStoreReplacesOwnedProvenanceAndPreservesForeignXml() async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "wb-provenance-save")
    defer { try? FileManager.default.removeItem(at: root) }
    let raw = root.appendingPathComponent("photo.dng")
    let sidecar = SidecarPath.sidecarURL(for: raw)
    var sampled = AdjustmentModel()
    sampled.wbSource = .sampled
    sampled.wbSampleX = 0.25
    sampled.wbSampleY = 0.75
    sampled.wbAlgorithmVersion = 1
    let foreign =
      "<vendor:Audit xmlns:vendor=\"urn:maple:test:foreign\"> exact &amp; kept </vendor:Audit>"
    let original = XMPSerializer.serialize(
      model: sampled, culling: CullingState(),
      passthrough: XMPPassthrough(unknownNodes: [foreign]))
    try Data(original.utf8).write(to: sidecar)
    let store = XMPSidecarStore(rawURL: raw)
    _ = try await store.load()
    var manual = sampled
    manual.wbSource = .manual
    manual.wbSampleX = 0
    manual.wbSampleY = 0
    manual.wbAlgorithmVersion = 0
    manual.tint = 9
    try await store.writeConfirmed(model: manual, culling: CullingState())
    let saved = try String(contentsOf: sidecar, encoding: .utf8)
    _ = try WorkflowSidecarCore.checkpoint(xmp: saved)  // Reject duplicate XML attributes.
    XCTAssertEqual(saved.components(separatedBy: "papp:WbSource=").count - 1, 1)
    XCTAssertFalse(saved.contains("papp:WbSampleX="))
    XCTAssertFalse(saved.contains("papp:WbSampleY="))
    XCTAssertFalse(saved.contains("papp:WbAlgorithmVersion="))
    XCTAssertTrue(saved.contains(foreign))
    let reopened = XMPSidecarStore(rawURL: raw)
    let loaded = try await reopened.load()
    XCTAssertEqual(loaded.0.wbSource, .manual)
    XCTAssertEqual(loaded.0.tint, 9)
  }

  private func xmp(attrs: String) -> String {
    """
    <x:xmpmeta xmlns:x="adobe:ns:meta/">
     <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description rdf:about=""
        xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
        xmlns:papp="http://ns.justmaple.app/1.0/"
        \(attrs)/>
     </rdf:RDF>
    </x:xmpmeta>
    """
  }
}
