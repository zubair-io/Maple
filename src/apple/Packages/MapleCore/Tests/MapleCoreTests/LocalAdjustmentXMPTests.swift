// LocalAdjustmentXMPTests.swift — nested-element XMP I/O for local
// adjustments (#358): the canonical `crs:GradientBasedCorrections` /
// `crs:CircularGradientBasedCorrections` containers.
//
// `canonicalBlock` below is the cross-language parity artifact: the same
// literal appears in the Rust suite (`raw-core/src/xmp/tests_local_adjustments.rs`),
// the TypeScript suite (`local-adjustments.spec.ts`) and the C# suite
// (`XmpLocalAdjustmentsTests.cs`), and all four serializers must produce it
// byte-for-byte from the same two-layer model at the same indent — the same
// contract `ToneCurveXMPTests` pins for the tone curves.

import XCTest

@testable import MapleCore

/// Six spaces — the canonical depth for children of `rdf:Description`.
private let canonicalIndent = "      "

/// The linear half of the shared fixture (`linear_layer()` in Rust).
private let linearLayer = LocalAdjustment(
    mask: .linear(start: MaskPoint(x: 0.2, y: 0.3), end: MaskPoint(x: 0.8, y: 0.7), feather: 0.4),
    range: .skinTone,
    adjustments: PartialAdjustments(exposure: 0.5, shadows: -20, hue: -35))

/// The radial half (`radial_layer()` in Rust). Binary-exact fractions so the
/// wire form's `center ± radii` bounding box round-trips to bit-identical
/// doubles; the angle is built with the same expression the parser uses.
private let radialLayer = LocalAdjustment(
    mask: .radial(
        center: MaskPoint(x: 0.5, y: 0.375), radii: MaskPoint(x: 0.25, y: 0.125),
        angle: LocalAdjustmentXMP.degreesToRadians(45), feather: 0.6, invert: true),
    range: .color(hueDeg: 210, hueHalfWidthDeg: 40, chromaMin: 0.1, lMin: 0, lMax: 1, feather: 0),
    adjustments: PartialAdjustments(contrast: 15, vibrance: -10, temperature: 200, hue: 0))

/// Cross-language byte-parity fixture — see the file header.
private let canonicalBlock = """
      <crs:GradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:What="Correction"
              crs:CorrectionAmount="1"
              crs:CorrectionActive="True"
              crs:LocalExposure2012="0.5"
              crs:LocalShadows2012="-20"
              crs:LocalHue="-0.35"
              papp:RangeKind="Color"
              papp:RangeHue="55"
              papp:RangeHueWidth="25"
              papp:RangeChromaMin="0.02"
              papp:RangeLMin="0.15"
              papp:RangeLMax="0.95"
              papp:RangeFeather="0.3">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/Gradient"
                    crs:MaskValue="1"
                    crs:ZeroX="0.2" crs:ZeroY="0.3"
                    crs:FullX="0.8" crs:FullY="0.7"
                    papp:LocalFeather="0.4"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:GradientBasedCorrections>
      <crs:CircularGradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:What="Correction"
              crs:CorrectionAmount="1"
              crs:CorrectionActive="True"
              crs:LocalContrast2012="15"
              papp:LocalVibrance="-10"
              crs:LocalTemperature="200"
              crs:LocalHue="0"
              papp:RangeKind="Color"
              papp:RangeHue="210"
              papp:RangeHueWidth="40"
              papp:RangeChromaMin="0.1"
              papp:RangeLMin="0"
              papp:RangeLMax="1"
              papp:RangeFeather="0">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/CircularGradient"
                    crs:MaskValue="1"
                    crs:Top="0.25" crs:Left="0.25" crs:Bottom="0.5" crs:Right="0.75"
                    crs:Angle="45" crs:Midpoint="50" crs:Roundness="0"
                    crs:Feather="60" crs:Flipped="True"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:CircularGradientBasedCorrections>
"""

/// Wrap a nested child block in a sidecar envelope.
private func sidecar(_ children: String) -> String {
    """
    <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
    <x:xmpmeta xmlns:x="adobe:ns:meta/">
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <rdf:Description
          xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
          xmlns:papp="http://ns.justmaple.app/photo/1.0/"
          crs:Version="11.0">
    \(children)
        </rdf:Description>
      </rdf:RDF>
    </x:xmpmeta>
    <?xpacket end="w"?>
    """
}

/// One gradient correction with the given description attributes and mask leaf.
private func gradientCorrection(_ descriptionAttrs: String, _ maskLeaf: String) -> String {
    """
          <crs:GradientBasedCorrections>
            <rdf:Seq>
              <rdf:li>
                <rdf:Description \(descriptionAttrs)>
                  <crs:CorrectionMasks>
                    <rdf:Seq>
                      \(maskLeaf)
                    </rdf:Seq>
                  </crs:CorrectionMasks>
                </rdf:Description>
              </rdf:li>
            </rdf:Seq>
          </crs:GradientBasedCorrections>
    """
}

private let fullFrameGradient =
    "<rdf:li crs:What=\"Mask/Gradient\" crs:MaskValue=\"1\" crs:ZeroX=\"0\" crs:ZeroY=\"0\" crs:FullX=\"1\" crs:FullY=\"0\"/>"

private func makeTempDirectory() throws -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-xmp-358-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

final class LocalAdjustmentXMPTests: XCTestCase {

    private func withLayers(_ layers: [LocalAdjustment]) -> AdjustmentModel {
        var model = AdjustmentModel()
        model.localAdjustments = layers
        return model
    }

    // MARK: - Cross-language parity

    func testSerializesCanonicalBlockFromAHandBuiltModel() {
        XCTAssertEqual(
            XMPSerializer._buildLocalAdjustmentsBlock(
                model: withLayers([linearLayer, radialLayer]), indent: canonicalIndent),
            canonicalBlock)
    }

    func testParsesCanonicalBlockIntoTheFixtureLayers() throws {
        let (model, _) = try XMPParser.parse(sidecar(canonicalBlock))
        XCTAssertEqual(model.localAdjustments, [linearLayer, radialLayer])
    }

    /// bytes → model → bytes is the identity function.
    func testRoundTripsCanonicalBlockByteForByte() throws {
        let (model, _) = try XMPParser.parse(sidecar(canonicalBlock))
        XCTAssertEqual(
            XMPSerializer._buildLocalAdjustmentsBlock(model: model, indent: canonicalIndent),
            canonicalBlock)
    }

    // MARK: - Whole-document behaviour

    /// The containers are modeled, not passthrough: a Maple-authored sidecar
    /// parses to an empty node bucket, and a re-save is a fixed point.
    func testRidesTheModelNotThePassthroughBucket() throws {
        let original = XMPSerializer.serialize(
            model: withLayers([linearLayer, radialLayer]), culling: CullingState())
        XCTAssertTrue(original.contains(canonicalBlock), original)

        let passthrough = XMPParser.parsePassthrough(original)
        XCTAssertTrue(passthrough.unknownNodes.isEmpty, "\(passthrough.unknownNodes)")

        let (model, culling) = try XMPParser.parse(original)
        XCTAssertEqual(model.localAdjustments, [linearLayer, radialLayer])
        XCTAssertEqual(
            XMPSerializer.serialize(model: model, culling: culling, passthrough: passthrough),
            original)
    }

    /// Identity is silence — an empty stack adds nothing, so a sidecar
    /// written before #358 stays byte-identical after a re-save.
    func testEmptyStackEmitsNothing() {
        let xml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(xml.contains("GradientBasedCorrections"))
        XCTAssertFalse(xml.contains("</rdf:Description>"))
        XCTAssertEqual(
            XMPSerializer._buildLocalAdjustmentsBlock(model: AdjustmentModel(), indent: canonicalIndent),
            "")
    }

    /// The metadata-carrying overload must not drop an authored mask.
    func testMetadataOverloadKeepsTheLayers() throws {
        var metadata = XmpMetadata()
        metadata.city = "Lisbon"
        let xml = XMPSerializer.serialize(
            model: withLayers([radialLayer]), culling: CullingState(), metadata: metadata)
        XCTAssertTrue(xml.contains("<crs:CircularGradientBasedCorrections>"))
        let (reparsed, _) = try XMPParser.parse(xml)
        XCTAssertEqual(reparsed.localAdjustments, [radialLayer])
    }

    func testInterleavedStackWritesTwoContiguousRunsLinearFirst() {
        let block = XMPSerializer._buildLocalAdjustmentsBlock(
            model: withLayers([radialLayer, linearLayer, radialLayer]), indent: canonicalIndent)
        guard let gradient = block.range(of: "<crs:GradientBasedCorrections>"),
              let circular = block.range(of: "<crs:CircularGradientBasedCorrections>")
        else { return XCTFail("both containers must be emitted: \(block)") }
        XCTAssertLessThan(gradient.lowerBound, circular.lowerBound)
        XCTAssertEqual(block.components(separatedBy: "Mask/CircularGradient").count - 1, 2)
    }

    /// Real files in a temp directory through the on-disk store, per
    /// CLAUDE.md's no-mocks-for-sidecars rule: load → edit → flush keeps the
    /// layers, and a second save is a fixed point.
    func testRoundTripsThroughARealSidecarFile() async throws {
        let dir = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let rawURL = dir.appendingPathComponent("photo.dng")
        let sidecarURL = SidecarPath.sidecarURL(for: rawURL)
        try sidecar(canonicalBlock).write(to: sidecarURL, atomically: true, encoding: .utf8)

        let store = XMPSidecarStore(rawURL: rawURL)
        let (model, culling) = try await store.load()
        XCTAssertEqual(model.localAdjustments, [linearLayer, radialLayer])

        var edited = model
        edited.exposure = 1.25
        await store.update(model: edited, culling: culling)
        await store.flush()
        let first = try String(contentsOf: sidecarURL, encoding: .utf8)
        XCTAssertTrue(first.contains("crs:Exposure2012=\"1.25\""))
        XCTAssertTrue(first.contains(canonicalBlock), first)

        let reopened = XMPSidecarStore(rawURL: rawURL)
        let (reloaded, reloadedCulling) = try await reopened.load()
        XCTAssertEqual(reloaded.localAdjustments, [linearLayer, radialLayer])
        await reopened.update(model: reloaded, culling: reloadedCulling)
        await reopened.flush()
        XCTAssertEqual(try String(contentsOf: sidecarURL, encoding: .utf8), first)
    }

    // MARK: - Tolerant reader

    func testUnrecognizedMaskKindDropsThatCorrectionOnly() throws {
        let doc = sidecar(gradientCorrection(
            "crs:What=\"Correction\" crs:CorrectionActive=\"True\" crs:LocalExposure2012=\"1\"",
            "<rdf:li crs:What=\"Mask/Brush\" crs:MaskValue=\"1\"/>"))
        let (model, _) = try XMPParser.parse(doc)
        XCTAssertTrue(model.localAdjustments.isEmpty)
        XCTAssertTrue(XMPParser.parsePassthrough(doc).unknownNodes.isEmpty)
    }

    func testInactiveCorrectionIsDropped() throws {
        let doc = sidecar(gradientCorrection(
            "crs:What=\"Correction\" crs:CorrectionActive=\"False\" crs:LocalExposure2012=\"2\"",
            fullFrameGradient))
        let (model, _) = try XMPParser.parse(doc)
        XCTAssertTrue(model.localAdjustments.isEmpty)
    }

    func testCorrectionAmountScalesEverySlider() throws {
        let doc = sidecar(gradientCorrection(
            "crs:What=\"Correction\" crs:CorrectionAmount=\"0.5\" crs:LocalExposure2012=\"2\" crs:LocalContrast2012=\"-40\"",
            fullFrameGradient))
        let (model, _) = try XMPParser.parse(doc)
        XCTAssertEqual(model.localAdjustments.count, 1)
        XCTAssertEqual(model.localAdjustments[0].adjustments,
                       PartialAdjustments(exposure: 1, contrast: -20))
    }

    func testMissingRequiredGeometryDropsTheMaskRatherThanInventingADefault() throws {
        let doc = sidecar(gradientCorrection(
            "crs:What=\"Correction\" crs:LocalExposure2012=\"1\"",
            "<rdf:li crs:What=\"Mask/Gradient\" crs:MaskValue=\"1\" crs:ZeroY=\"0\" crs:FullX=\"1\" crs:FullY=\"1\"/>"))
        let (model, _) = try XMPParser.parse(doc)
        XCTAssertTrue(model.localAdjustments.isEmpty)
    }

    func testNonSelfClosingLeafAndCaseInsensitiveBooleans() throws {
        let doc = sidecar(gradientCorrection(
            "crs:What=\"Correction\" crs:CorrectionActive=\"on\" crs:LocalExposure2012=\"0.5\"",
            "<rdf:li crs:What=\"Mask/Gradient\" crs:MaskValue=\"1\" crs:ZeroX=\"0.1\" crs:ZeroY=\"0.2\" crs:FullX=\"0.9\" crs:FullY=\"0.8\"></rdf:li>"))
        let (model, _) = try XMPParser.parse(doc)
        XCTAssertEqual(model.localAdjustments, [
            LocalAdjustment(
                mask: .linear(start: MaskPoint(x: 0.1, y: 0.2), end: MaskPoint(x: 0.9, y: 0.8), feather: 0.5),
                adjustments: PartialAdjustments(exposure: 0.5)),
        ])
    }

    /// A Lightroom-authored radial correction imports as the nearest
    /// ellipse; the attributes Maple has no field for are ignored.
    func testImportsALightroomRadialCorrection() throws {
        let doc = sidecar("""
              <crs:CircularGradientBasedCorrections>
                <rdf:Seq>
                  <rdf:li>
                    <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="true"
                      crs:LocalSaturation="-15" crs:LocalClarity2012="20" crs:LocalTemperature="-50">
                      <crs:CorrectionMasks>
                        <rdf:Seq>
                          <rdf:li crs:What="Mask/CircularGradient" crs:MaskValue="1"
                            crs:Top="0.25" crs:Left="0.25" crs:Bottom="0.5" crs:Right="0.75"
                            crs:Angle="0" crs:Midpoint="50" crs:Roundness="20" crs:Feather="50" crs:Flipped="false"
                            crs:MaskName="Radial Gradient 1" crs:MaskSyncID="ABC"/>
                        </rdf:Seq>
                      </crs:CorrectionMasks>
                    </rdf:Description>
                  </rdf:li>
                </rdf:Seq>
              </crs:CircularGradientBasedCorrections>
        """)
        let (model, _) = try XMPParser.parse(doc)
        XCTAssertEqual(model.localAdjustments, [
            LocalAdjustment(
                mask: .radial(
                    center: MaskPoint(x: 0.5, y: 0.375), radii: MaskPoint(x: 0.25, y: 0.125),
                    angle: 0, feather: 0.5, invert: false),
                adjustments: PartialAdjustments(saturation: -15, temperature: -50)),
        ])
    }

    /// The other nested elements (keyword bag, point curves) must survive
    /// alongside the containers in one document.
    func testCoexistsWithKeywordsAndToneCurves() throws {
        var model = withLayers([linearLayer])
        model.toneCurveLuma = ToneCurve(points: [(x: 0, y: 0), (x: 0.5, y: 0.6), (x: 1, y: 1)])
        let culling = CullingState(stars: 3, flag: .pick, keywords: ["alpha"])
        let xml = XMPSerializer.serialize(model: model, culling: culling)
        let (reparsed, reparsedCulling) = try XMPParser.parse(xml)
        XCTAssertEqual(reparsed.localAdjustments, [linearLayer])
        XCTAssertEqual(reparsed.toneCurveLuma, model.toneCurveLuma)
        XCTAssertEqual(reparsedCulling.keywords, ["alpha"])
        XCTAssertEqual(XMPSerializer.serialize(model: reparsed, culling: reparsedCulling), xml)
    }
}
