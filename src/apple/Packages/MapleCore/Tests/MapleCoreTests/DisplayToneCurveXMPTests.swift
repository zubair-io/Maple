// DisplayToneCurveXMPTests.swift — nested-element XMP I/O for the four
// display-referred point tone curves (#2232, Adobe's `crs:ToneCurvePV2012*`).
//
// Sibling of `ToneCurveXMPTests.swift` (the scene-linear `papp:` family).
// `canonicalBlock` here is this ticket's own cross-language parity artifact
// — the same literal must appear in `tests_display_tone_curves.rs` and
// `point-tone-curve.spec.ts`.

import XCTest

@testable import MapleCore

/// Child indent used by the parity fixture (`docs/xmp-canonical-format.md`
/// § "Indentation").
private let canonicalIndent = "      "

/// Cross-language byte-parity fixture — a non-identity three-point master
/// curve (deliberately a different shape from `ToneCurveXMPTests`'
/// five-point fixture — PV2012's own editor authors fewer knots on average).
private let canonicalBlock = """
      <crs:ToneCurvePV2012>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>128, 150</rdf:li>
          <rdf:li>255, 255</rdf:li>
        </rdf:Seq>
      </crs:ToneCurvePV2012>
"""

/// The `[0, 1]` model form of `canonicalBlock`.
private let canonicalPoints: [ToneCurvePoint] = [
    (x: 0.0, y: 0.0),
    (x: 128.0 / 255.0, y: 150.0 / 255.0),
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

final class DisplayToneCurveXMPTests: XCTestCase {

    // MARK: - Parse

    func testParsesNestedThreePointMasterCurve() throws {
        let (model, _) = try XMPParser.parse(sidecar(canonicalBlock))
        XCTAssertEqual(model.displayToneCurveLuma.points.count, 3)
        for (got, want) in zip(model.displayToneCurveLuma.points, canonicalPoints) {
            XCTAssertEqual(got.x, want.x, accuracy: 1e-9)
            XCTAssertEqual(got.y, want.y, accuracy: 1e-9)
        }
        // The scene-linear family and the display R/G/B siblings stay identity.
        XCTAssertTrue(model.toneCurveLuma.isIdentity)
        XCTAssertTrue(model.displayToneCurveRed.isIdentity)
        XCTAssertTrue(model.displayToneCurveGreen.isIdentity)
        XCTAssertTrue(model.displayToneCurveBlue.isIdentity)
    }

    /// The load-bearing acceptance test: bytes → model → bytes is the identity
    /// function for a non-identity display-referred curve.
    func testRoundTripsThreePointCurveByteForByte() throws {
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
        model.displayToneCurveLuma = ToneCurve(points: canonicalPoints)
        XCTAssertEqual(
            XMPSerializer._buildToneCurvesBlock(model: model, indent: canonicalIndent),
            canonicalBlock
        )
    }

    // MARK: - Identity

    func testIdentityCurvesEmitNothing() {
        let xml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(xml.contains("ToneCurvePV2012"))
    }

    // MARK: - Full document round-trip

    /// Both families coexist on one image and emit in the documented order:
    /// the scene-linear block first, then the four display-referred ones.
    func testBothFamiliesCoexistAndEmitInCanonicalOrder() throws {
        var model = AdjustmentModel()
        model.toneCurveLuma = ToneCurve(points: [(x: 0.0, y: 0.0), (x: 1.0, y: 1.0)])
        model.displayToneCurveLuma = ToneCurve(points: [(x: 0.0, y: 0.0), (x: 1.0, y: 1.0)])
        model.displayToneCurveRed = ToneCurve(
            points: [(x: 0.0, y: 0.0), (x: 0.5, y: 0.6), (x: 1.0, y: 1.0)])
        model.displayToneCurveGreen = ToneCurve(
            points: [(x: 0.0, y: 0.0), (x: 0.25, y: 0.2), (x: 1.0, y: 1.0)])
        model.displayToneCurveBlue = ToneCurve(points: [(x: 0.0, y: 0.1), (x: 1.0, y: 0.9)])

        let xml = XMPSerializer.serialize(model: model, culling: CullingState())
        let order = [
            "<papp:SceneLinearToneCurve>",
            "<crs:ToneCurvePV2012>",
            "<crs:ToneCurvePV2012Red>",
            "<crs:ToneCurvePV2012Green>",
            "<crs:ToneCurvePV2012Blue>",
        ].map { xml.range(of: $0)?.lowerBound }
        XCTAssertFalse(order.contains(where: { $0 == nil }), "all five curves must be emitted")
        let bounds = order.compactMap { $0 }
        XCTAssertEqual(bounds, bounds.sorted())

        let (reparsed, _) = try XMPParser.parse(xml)
        XCTAssertEqual(reparsed.toneCurveLuma, model.toneCurveLuma)
        XCTAssertEqual(reparsed.displayToneCurveLuma, model.displayToneCurveLuma)
        XCTAssertEqual(reparsed.displayToneCurveRed, model.displayToneCurveRed)
        XCTAssertEqual(reparsed.displayToneCurveGreen, model.displayToneCurveGreen)
        XCTAssertEqual(reparsed.displayToneCurveBlue, model.displayToneCurveBlue)
        XCTAssertEqual(XMPSerializer.serialize(model: reparsed, culling: CullingState()), xml)
    }

    // MARK: - Real ACR-authored sample

    /// A genuine Lightroom Classic export (`XMPPassthroughTests.lightroomSidecar`
    /// — reused rather than duplicated, per `SidecarContractSupport.swift`'s
    /// convention) parses its master `crs:ToneCurvePV2012` structurally, while
    /// the mask group / snapshot stack / edit history alongside it still ride
    /// the unknown-node passthrough untouched.
    func testAcrAuthoredSidecarParsesTheMasterCurve() throws {
        let (model, _) = try XMPParser.parse(XMPPassthroughTests.lightroomSidecar)
        XCTAssertEqual(model.displayToneCurveLuma.points.count, 3)
        let expected: [ToneCurvePoint] = [
            (x: 0.0, y: 0.0), (x: 32.0 / 255.0, y: 22.0 / 255.0), (x: 1.0, y: 1.0),
        ]
        for (got, want) in zip(model.displayToneCurveLuma.points, expected) {
            XCTAssertEqual(got.x, want.x, accuracy: 1e-9)
            XCTAssertEqual(got.y, want.y, accuracy: 1e-9)
        }
        // Flat attributes on the same element still parse alongside the
        // nested curve.
        XCTAssertEqual(model.exposure, 0.35, accuracy: 1e-9)
    }
}
