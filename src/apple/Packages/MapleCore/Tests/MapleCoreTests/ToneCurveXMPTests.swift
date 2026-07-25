// ToneCurveXMPTests.swift — nested-element XMP I/O for the four point tone
// curves (#365).
//
// `canonicalBlock` below is the cross-language parity artifact: the same
// literal appears in the Rust suite (`raw-core/src/xmp/tests_tone_curves.rs`)
// and the TypeScript suite (`point-tone-curve.spec.ts`), and all three
// serializers must produce it byte-for-byte from the same model at the same
// indent. Whole *documents* still differ across the three writers (namespace
// URIs, `x:xmptk`, attribute order — see the header on
// `XMPSerialization.swift`), so the block is the unit of byte parity, not the
// file.

import XCTest

@testable import MapleCore

/// Child indent used by the parity fixture. Six spaces is the canonical depth
/// for children of `rdf:Description` per `docs/xmp-canonical-format.md`
/// § "Indentation", and the depth Apple's own writer emits at.
private let canonicalIndent = "      "

/// Cross-language byte-parity fixture — a non-identity five-point luma curve.
private let canonicalBlock = """
      <papp:SceneLinearToneCurve>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>64, 48</rdf:li>
          <rdf:li>128, 140</rdf:li>
          <rdf:li>192, 205</rdf:li>
          <rdf:li>255, 255</rdf:li>
        </rdf:Seq>
      </papp:SceneLinearToneCurve>
"""

/// The `[0, 1]` model form of `canonicalBlock`.
private let canonicalPoints: [ToneCurvePoint] = [
    (x: 0.0, y: 0.0),
    (x: 64.0 / 255.0, y: 48.0 / 255.0),
    (x: 128.0 / 255.0, y: 140.0 / 255.0),
    (x: 192.0 / 255.0, y: 205.0 / 255.0),
    (x: 1.0, y: 1.0),
]

/// Wrap a nested child block in a sidecar envelope.
private func sidecar(_ children: String) -> String {
    """
    <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
    <x:xmpmeta xmlns:x="adobe:ns:meta/">
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <rdf:Description
          xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
          xmlns:dc="http://purl.org/dc/elements/1.1/"
          xmlns:papp="http://ns.justmaple.app/1.0/"
          crs:Version="11.0">
    \(children)
        </rdf:Description>
      </rdf:RDF>
    </x:xmpmeta>
    <?xpacket end="w"?>
    """
}

final class ToneCurveXMPTests: XCTestCase {

    // MARK: - Parse

    func testParsesNestedFivePointLumaCurve() throws {
        let (model, _) = try XMPParser.parse(sidecar(canonicalBlock))
        XCTAssertEqual(model.toneCurveLuma.points.count, 5)
        for (got, want) in zip(model.toneCurveLuma.points, canonicalPoints) {
            XCTAssertEqual(got.x, want.x, accuracy: 1e-9)
            XCTAssertEqual(got.y, want.y, accuracy: 1e-9)
        }
        XCTAssertTrue(model.toneCurveRed.isIdentity)
        XCTAssertTrue(model.toneCurveGreen.isIdentity)
        XCTAssertTrue(model.toneCurveBlue.isIdentity)
    }

    /// The load-bearing acceptance test: bytes → model → bytes is the identity
    /// function for a non-identity five-point curve.
    func testRoundTripsFivePointCurveByteForByte() throws {
        let (model, _) = try XMPParser.parse(sidecar(canonicalBlock))
        XCTAssertEqual(
            XMPSerializer._buildToneCurvesBlock(model: model, indent: canonicalIndent),
            canonicalBlock
        )
    }

    /// Cross-language parity: the same block bytes Rust's
    /// `serialize_tone_curves` and TypeScript's `toneCurveBlocks` emit.
    func testSerializesCanonicalBlockFromAHandBuiltModel() {
        var model = AdjustmentModel()
        model.toneCurveLuma = ToneCurve(points: canonicalPoints)
        XCTAssertEqual(
            XMPSerializer._buildToneCurvesBlock(model: model, indent: canonicalIndent),
            canonicalBlock
        )
    }

    // MARK: - Identity

    /// Identity is silence — an unedited model must add nothing to the
    /// document, so a sidecar written before #365 stays byte-identical after a
    /// re-save and the `rdf:Description` stays self-closing.
    func testIdentityCurvesEmitNothing() {
        let xml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(xml.contains("SceneLinearToneCurve"))
        XCTAssertFalse(xml.contains("rdf:Seq"))
        XCTAssertTrue(xml.contains("/>"), "no nested children — description stays self-closing")
    }

    /// An explicitly empty `rdf:Seq` parses back to identity and re-serializes
    /// to nothing rather than to an empty container.
    func testEmptySeqParsesAsIdentityAndEmitsNothing() throws {
        let block = """
              <papp:SceneLinearToneCurve>
                <rdf:Seq>
                </rdf:Seq>
              </papp:SceneLinearToneCurve>
        """
        let (model, _) = try XMPParser.parse(sidecar(block))
        XCTAssertTrue(model.toneCurveLuma.isIdentity)
        XCTAssertEqual(
            XMPSerializer._buildToneCurvesBlock(model: model, indent: canonicalIndent), "")
    }

    // MARK: - Full document round-trip

    func testAllFourChannelsRoundTripThroughAFullSidecar() throws {
        var model = AdjustmentModel()
        model.toneCurveLuma = ToneCurve(points: [(x: 0.0, y: 0.0), (x: 1.0, y: 1.0)])
        model.toneCurveRed = ToneCurve(points: [(x: 0.0, y: 0.0), (x: 0.5, y: 0.6), (x: 1.0, y: 1.0)])
        model.toneCurveGreen = ToneCurve(points: [(x: 0.0, y: 0.0), (x: 0.25, y: 0.2), (x: 1.0, y: 1.0)])
        model.toneCurveBlue = ToneCurve(points: [(x: 0.0, y: 0.1), (x: 1.0, y: 0.9)])

        let xml = XMPSerializer.serialize(model: model, culling: CullingState())
        // Canonical child order: luma, red, green, blue.
        let order = [
            "<papp:SceneLinearToneCurve>",
            "<papp:SceneLinearToneCurveRed>",
            "<papp:SceneLinearToneCurveGreen>",
            "<papp:SceneLinearToneCurveBlue>",
        ].map { xml.range(of: $0)?.lowerBound }
        XCTAssertFalse(order.contains(where: { $0 == nil }), "all four curves must be emitted")
        let bounds = order.compactMap { $0 }
        XCTAssertEqual(bounds, bounds.sorted())

        let (reparsed, _) = try XMPParser.parse(xml)
        XCTAssertEqual(reparsed.toneCurveLuma, model.toneCurveLuma)
        XCTAssertEqual(reparsed.toneCurveRed, model.toneCurveRed)
        XCTAssertEqual(reparsed.toneCurveGreen, model.toneCurveGreen)
        XCTAssertEqual(reparsed.toneCurveBlue, model.toneCurveBlue)
        XCTAssertEqual(XMPSerializer.serialize(model: reparsed, culling: CullingState()), xml)
    }

    /// Non-integer wire coordinates survive the two-decimal canonical codec.
    func testFractionalCoordinatesRoundTrip() throws {
        let block = """
              <papp:SceneLinearToneCurveRed>
                <rdf:Seq>
                  <rdf:li>0, 0</rdf:li>
                  <rdf:li>127.5, 130.25</rdf:li>
                  <rdf:li>255, 255</rdf:li>
                </rdf:Seq>
              </papp:SceneLinearToneCurveRed>
        """
        let (model, _) = try XMPParser.parse(sidecar(block))
        let emitted = XMPSerializer._buildToneCurvesBlock(model: model, indent: canonicalIndent)
        XCTAssertTrue(emitted.contains("<rdf:li>127.5, 130.25</rdf:li>"), emitted)
    }

    // MARK: - Namespace decision

    /// Lightroom's display-referred curves are a different quantity (post-AgX)
    /// and must NOT land in the scene-linear fields — applying a
    /// display-referred shape to scene-linear light renders the image visibly
    /// wrong. See `docs/xmp-canonical-format.md` § "Tone curves".
    func testCrsToneCurvePV2012IsNotParsedIntoSceneLinearFields() throws {
        let block = """
              <crs:ToneCurvePV2012>
                <rdf:Seq>
                  <rdf:li>0, 0</rdf:li>
                  <rdf:li>128, 180</rdf:li>
                  <rdf:li>255, 255</rdf:li>
                </rdf:Seq>
              </crs:ToneCurvePV2012>
        """
        let (model, _) = try XMPParser.parse(sidecar(block))
        XCTAssertTrue(model.toneCurveLuma.isIdentity)
        XCTAssertTrue(model.toneCurveRed.isIdentity)
        XCTAssertTrue(model.toneCurveGreen.isIdentity)
        XCTAssertTrue(model.toneCurveBlue.isIdentity)
    }

    // MARK: - Interaction with the other nested element

    /// The keyword bag is the schema's other nested element; the curve walker
    /// must not swallow its `rdf:li` children, and vice versa.
    func testKeywordsAndCurvesCoexist() throws {
        let block = """
              <dc:subject>
                <rdf:Bag>
                  <rdf:li>sunset</rdf:li>
                  <rdf:li>beach</rdf:li>
                </rdf:Bag>
              </dc:subject>
        \(canonicalBlock)
        """
        let (model, culling) = try XMPParser.parse(sidecar(block))
        XCTAssertEqual(culling.keywords, ["sunset", "beach"])
        XCTAssertEqual(model.toneCurveLuma.points.count, 5)

        // And the write path emits both blocks in one document.
        let xml = XMPSerializer.serialize(
            model: model, culling: CullingState(keywords: ["sunset", "beach"]))
        XCTAssertTrue(xml.contains("<dc:subject>"))
        XCTAssertTrue(xml.contains("<papp:SceneLinearToneCurve>"))
        let (m2, c2) = try XMPParser.parse(xml)
        XCTAssertEqual(c2.keywords, ["sunset", "beach"])
        XCTAssertEqual(m2.toneCurveLuma, model.toneCurveLuma)
    }

    /// A metadata-carrying save must not drop an authored curve — the same
    /// silent-data-loss shape #2191 fixed for the parametric scalars.
    func testMetadataOverloadKeepsCurves() throws {
        var model = AdjustmentModel()
        model.toneCurveLuma = ToneCurve(points: canonicalPoints)
        var metadata = XmpMetadata()
        metadata.title = "Dune"
        let xml = XMPSerializer.serialize(
            model: model, culling: CullingState(), metadata: metadata)
        XCTAssertTrue(xml.contains("<papp:SceneLinearToneCurve>"), xml)
        let (reparsed, _) = try XMPParser.parse(xml)
        XCTAssertEqual(reparsed.toneCurveLuma, model.toneCurveLuma)
    }

    // MARK: - On-disk round trip (no mocks — CLAUDE.md)

    /// The exact user save → reopen path, against a real `.xmp` file in a
    /// temp directory.
    func testSidecarStoreRoundTripsCurvesOnDisk() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        defer {
            let xmpURL = tmp.deletingPathExtension().appendingPathExtension("xmp")
            try? FileManager.default.removeItem(at: xmpURL)
        }

        var model = AdjustmentModel.default
        model.toneCurveLuma = ToneCurve(points: canonicalPoints)
        model.toneCurveBlue = ToneCurve(points: [(x: 0.0, y: 0.1), (x: 1.0, y: 0.9)])

        let store = XMPSidecarStore(rawURL: tmp)
        await store.update(model: model, culling: CullingState())
        await store.flush()

        // Drop the in-memory cache so the read actually goes to disk.
        let fresh = XMPSidecarStore(rawURL: tmp)
        let (loaded, _) = try await fresh.load()
        XCTAssertEqual(loaded.toneCurveLuma, model.toneCurveLuma)
        XCTAssertEqual(loaded.toneCurveBlue, model.toneCurveBlue)
        XCTAssertTrue(loaded.toneCurveRed.isIdentity)
    }
}
