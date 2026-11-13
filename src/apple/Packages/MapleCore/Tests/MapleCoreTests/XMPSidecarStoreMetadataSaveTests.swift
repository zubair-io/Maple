// XMPSidecarStoreMetadataSaveTests.swift — #4687.
//
// `XMPSidecarStore` routes a save through the metadata-carrying serializer
// overload whenever the sidecar on disk holds any modelled IPTC/EXIF field,
// even for a slider-only edit. That overload must emit exactly the develop
// children the base overload does — retouch spots, opaque mask-group
// templates, passthrough nodes — or a capture date on the photo turns every
// Apple save into silent data loss. Real files, real store, no mocks.

import XCTest

@testable import MapleCore

final class XMPSidecarStoreMetadataSaveTests: XCTestCase {

  static let sidecarWithDateSpotsAndOpaqueGroup = """
    <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
    <x:xmpmeta xmlns:x="adobe:ns:meta/">
     <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description rdf:about=""
        xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
        xmlns:exif="http://ns.adobe.com/exif/1.0/"
       crs:Version="15.0"
       crs:ProcessVersion="11.0"
       crs:Exposure2012="+0.35"
       exif:DateTimeOriginal="2024-05-01T10:20:30"
       crs:HasSettings="True">
       <crs:MaskGroupBasedCorrections>
        <rdf:Seq>
         <rdf:li>
          <rdf:Description
           crs:What="Correction"
           crs:CorrectionAmount="1"
           crs:CorrectionActive="true"
           crs:CorrectionName="Composition reference"
           crs:LocalExposure2012="1">
          <crs:CorrectionMasks>
           <rdf:Seq>
            <rdf:li
             crs:What="Mask/CircularGradient"
             crs:MaskActive="true"
             crs:MaskName="Radial reference"
             crs:MaskBlendMode="9"
             crs:MaskInverted="false"
             crs:MaskValue="1"
             crs:Top="0.2"
             crs:Left="0.2"
             crs:Bottom="0.8"
             crs:Right="0.8"
             crs:Angle="0"
             crs:Midpoint="50"
             crs:Roundness="0"
             crs:Feather="25"
             crs:Flipped="true"
             crs:Version="2"/>
           </rdf:Seq>
          </crs:CorrectionMasks>
          </rdf:Description>
         </rdf:li>
        </rdf:Seq>
       </crs:MaskGroupBasedCorrections>
       <crs:RetouchAreas>
        <rdf:Seq>
         <rdf:li>
          <rdf:Description
           crs:SpotType="heal"
           crs:SourceState="sourceSetExplicitly"
           crs:Method="circle"
           crs:SourceX="0.750000"
           crs:SourceY="0.500000"
           crs:Opacity="1.000000"
           crs:Feather="0.500000"
           crs:Seed="0">
           <crs:Masks>
            <rdf:Seq>
             <rdf:li
              crs:What="Mask/CircularGradient"
              crs:MaskValue="1"
              crs:X="0.250000"
              crs:Y="0.500000"
              crs:Radius="0.050000"
              crs:Flow="1"
              crs:CenterWeight="0"/>
            </rdf:Seq>
           </crs:Masks>
          </rdf:Description>
         </rdf:li>
         <rdf:li>
          <rdf:Description
           crs:SpotType="clone"
           crs:SourceState="sourceSetExplicitly"
           crs:Method="circle"
           crs:SourceX="0.100000"
           crs:SourceY="0.900000"
           crs:Opacity="0.800000"
           crs:Feather="0.250000"
           crs:Seed="0">
           <crs:Masks>
            <rdf:Seq>
             <rdf:li
              crs:What="Mask/CircularGradient"
              crs:MaskValue="1"
              crs:X="0.600000"
              crs:Y="0.400000"
              crs:Radius="0.030000"
              crs:Flow="1"
              crs:CenterWeight="0"/>
            </rdf:Seq>
           </crs:Masks>
          </rdf:Description>
         </rdf:li>
        </rdf:Seq>
       </crs:RetouchAreas>
      </rdf:Description>
     </rdf:RDF>
    </x:xmpmeta>
    <?xpacket end="w"?>
    """

  static let expectedSpots = [
    RetouchSpot(
      kind: .heal, center: RetouchPoint(x: 0.25, y: 0.5), source: RetouchPoint(x: 0.75, y: 0.5),
      radius: 0.05, feather: 0.5, opacity: 1),
    RetouchSpot(
      kind: .clone, center: RetouchPoint(x: 0.6, y: 0.4), source: RetouchPoint(x: 0.1, y: 0.9),
      radius: 0.03, feather: 0.25, opacity: 0.8),
  ]

  private func stageSidecar() throws -> (rawURL: URL, sidecarURL: URL) {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-xmp-4687-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
    let rawURL = dir.appendingPathComponent("DSCF4687.dng")
    try Data("not a real raw".utf8).write(to: rawURL)
    let sidecarURL = SidecarPath.sidecarURL(for: rawURL)
    try Self.sidecarWithDateSpotsAndOpaqueGroup.write(
      to: sidecarURL, atomically: true, encoding: .utf8)
    return (rawURL, sidecarURL)
  }

  private func opaqueGroupSource() throws -> String {
    try XCTUnwrap(
      XMPChildElementScanner.descriptionChildren(in: Self.sidecarWithDateSpotsAndOpaqueGroup)
        .first { $0.qName == "crs:MaskGroupBasedCorrections" }?.source)
  }

  private func occurrences(of needle: String, in haystack: String) -> Int {
    haystack.components(separatedBy: needle).count - 1
  }

  func testFixtureSelectsTheMetadataOverload() throws {
    let metadata = XMPParser.parseMetadata(Self.sidecarWithDateSpotsAndOpaqueGroup)
    XCTAssertFalse(metadata.isEmpty)
    XCTAssertEqual(metadata.dateTimeOriginal, "2024-05-01T10:20:30")
    let passthrough = XMPParser.parsePassthrough(Self.sidecarWithDateSpotsAndOpaqueGroup)
    XCTAssertFalse(passthrough.maskGroups.isEmpty, "the unsupported blend mode must stay opaque")
  }

  func testTwoSliderOnlySavesKeepSpotsOpaqueGroupAndDate() async throws {
    let (rawURL, sidecarURL) = try stageSidecar()
    let groupSource = try opaqueGroupSource()

    let store = XMPSidecarStore(rawURL: rawURL)
    let (model, culling) = try await store.load()
    XCTAssertEqual(model.retouchSpots, Self.expectedSpots)
    XCTAssertTrue(model.localAdjustments.isEmpty, "an opaque group is not a modelled layer")

    var first = model
    first.exposure = 1.25
    await store.update(model: first, culling: culling)
    await store.flush()

    let reopened = XMPSidecarStore(rawURL: rawURL)
    let (reloaded, reloadedCulling) = try await reopened.load()
    XCTAssertEqual(reloaded.retouchSpots, Self.expectedSpots, "spots must survive the first save")
    var second = reloaded
    second.contrast = 12
    await reopened.update(model: second, culling: reloadedCulling)
    await reopened.flush()

    let written = try String(contentsOf: sidecarURL, encoding: .utf8)
    let (final, _) = try XMPParser.parse(written)
    XCTAssertEqual(final.exposure, 1.25, accuracy: 1e-9)
    XCTAssertEqual(final.contrast, 12, accuracy: 1e-9)
    XCTAssertEqual(final.retouchSpots, Self.expectedSpots, "spots must survive the second save")
    XCTAssertTrue(final.localAdjustments.isEmpty)
    XCTAssertTrue(written.contains("exif:DateTimeOriginal=\"2024-05-01T10:20:30\""))
    XCTAssertTrue(written.contains(groupSource), "the opaque group must survive byte-for-byte")
    XCTAssertEqual(occurrences(of: "<crs:MaskGroupBasedCorrections>", in: written), 1)
    XCTAssertEqual(occurrences(of: "<crs:RetouchAreas>", in: written), 1)
    XCTAssertEqual(occurrences(of: "crs:SpotType=\"heal\"", in: written), 1)
    XCTAssertEqual(occurrences(of: "crs:SpotType=\"clone\"", in: written), 1)
  }

  func testSecondSaveIsAFixedPoint() async throws {
    let (rawURL, sidecarURL) = try stageSidecar()
    let store = XMPSidecarStore(rawURL: rawURL)
    let (model, culling) = try await store.load()
    var edited = model
    edited.exposure = 1.25
    await store.update(model: edited, culling: culling)
    await store.flush()
    let first = try String(contentsOf: sidecarURL, encoding: .utf8)

    let reopened = XMPSidecarStore(rawURL: rawURL)
    let (reloaded, reloadedCulling) = try await reopened.load()
    await reopened.update(model: reloaded, culling: reloadedCulling)
    await reopened.flush()
    let second = try String(contentsOf: sidecarURL, encoding: .utf8)
    XCTAssertEqual(second, first)
  }

  /// With only attribute-shaped metadata (no `dc:` blocks), the metadata
  /// overload's child region and its white-balance attributes must match
  /// the base overload byte-for-byte under both WB modes.
  func testMetadataOverloadMirrorsBaseOverloadDevelopChildrenAndWhiteBalance() throws {
    let source = Self.sidecarWithDateSpotsAndOpaqueGroup
    let (model, culling) = try XMPParser.parse(source)
    let metadata = XMPParser.parseMetadata(source)
    let passthrough = XMPParser.parsePassthrough(source)
    let wbAttributes = ["crs:Temperature=", "crs:Tint=", "papp:WbScaleVersion="]
    let childRegion = { (xml: String) -> String? in
      xml.range(of: "\n" + XMPCanonical.childIndent + "<").map { String(xml[$0.lowerBound...]) }
    }

    for omitWhiteBalance in [false, true] {
      let base = XMPSerializer.serialize(
        model: model, culling: culling, omitWhiteBalance: omitWhiteBalance,
        passthrough: passthrough)
      let withMetadata = XMPSerializer.serialize(
        model: model, culling: culling, metadata: metadata,
        omitWhiteBalance: omitWhiteBalance, passthrough: passthrough)
      XCTAssertTrue(withMetadata.contains("exif:DateTimeOriginal=\"2024-05-01T10:20:30\""))
      XCTAssertEqual(
        childRegion(withMetadata), childRegion(base), "omitWhiteBalance=\(omitWhiteBalance)")
      for attribute in wbAttributes {
        XCTAssertEqual(
          withMetadata.contains(attribute), base.contains(attribute),
          "\(attribute) omitWhiteBalance=\(omitWhiteBalance)")
        XCTAssertEqual(
          withMetadata.contains(attribute), !omitWhiteBalance,
          "\(attribute) omitWhiteBalance=\(omitWhiteBalance)")
      }
    }
  }
}
