// PerspectiveXMPTests.swift — XMP round-trip for the seven `crs:Perspective*`
// keys (#3410).
//
// Mirrors `FilmLookXMPTests.swift`: in-memory serialize/parse against the
// omit-on-default convention, plus the ticket's own acceptance criterion —
// a Lightroom-authored sidecar carrying a bare keystone must load it.

import XCTest

@testable import MapleCore

final class PerspectiveXMPTests: XCTestCase {

    // MARK: - Parse

    /// The ticket's acceptance criterion, in the smallest form that can fail.
    func testLightroomVerticalKeystoneLoadsAtTheAuthoredValue() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: #"crs:PerspectiveVertical="-20""#))
        XCTAssertEqual(m.perspective.vertical, -20)
        // The other six stay neutral — a partial sidecar must not disturb them.
        XCTAssertEqual(m.perspective.horizontal, 0)
        XCTAssertEqual(m.perspective.scale, 100)
    }

    func testAllSevenKeysParseIntoTheirOwnMembers() throws {
        let attrs = #"""
            crs:PerspectiveVertical="-20"
            crs:PerspectiveHorizontal="12.5"
            crs:PerspectiveRotate="-3.5"
            crs:PerspectiveScale="110"
            crs:PerspectiveAspect="-35"
            crs:PerspectiveX="8"
            crs:PerspectiveY="-6"
            """#
        let (m, _) = try XMPParser.parse(xmp(attrs: attrs))
        XCTAssertEqual(m.perspective.vertical, -20)
        XCTAssertEqual(m.perspective.horizontal, 12.5)
        XCTAssertEqual(m.perspective.rotate, -3.5)
        XCTAssertEqual(m.perspective.scale, 110)
        XCTAssertEqual(m.perspective.aspect, -35)
        XCTAssertEqual(m.perspective.x, 8)
        XCTAssertEqual(m.perspective.y, -6)
    }

    func testAFreshModelIsNeutralGeometry() {
        XCTAssertEqual(AdjustmentModel().perspective, .identity)
        XCTAssertTrue(AdjustmentModel().perspective.isIdentity)
    }

    // MARK: - Omit on default

    /// A sidecar for an image whose Geometry tool was never opened must stay
    /// byte-identical to what a build without the tool produced.
    func testDefaultsEmitNoPerspectiveAttributes() {
        let out = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(out.contains("crs:Perspective"))
    }

    /// The omit test is per-field, not per-group: an authored keystone must
    /// not drag a default scale into the sidecar with it.
    func testDefaultScaleIsOmittedAlongsideAuthoredSiblings() {
        var m = AdjustmentModel()
        m.perspective.vertical = -20
        let out = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(out.contains(#"crs:PerspectiveVertical="-20""#))
        XCTAssertFalse(out.contains("crs:PerspectiveScale"))
    }

    // MARK: - Round trip

    func testPerspectiveFieldsRoundTrip() throws {
        var m = AdjustmentModel()
        m.perspective = Perspective(
            vertical: -20, horizontal: 12.5, rotate: -3.5, scale: 110,
            aspect: -35, x: 8, y: -6)
        let out = XMPSerializer.serialize(model: m, culling: CullingState())
        let (back, _) = try XMPParser.parse(out)
        XCTAssertEqual(back.perspective, m.perspective)
    }

    // MARK: - Helpers

    private func xmp(attrs: String) -> String {
        """
        <?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description
              xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              xmlns:xmp="http://ns.adobe.com/xap/1.0/"
              xmlns:papp="http://ns.justmaple.app/1.0/"
              \(attrs)/>
          </rdf:RDF>
        </x:xmpmeta>
        """
    }
}

// MARK: - Tool catalog

/// The Geometry tool's own contract (#3410): seven sub-params whose ranges,
/// defaults and key paths come from the canonical generated schema, not from
/// numbers typed into the panel.
final class GeometryToolCatalogTests: XCTestCase {

    func testGeometryDeclaresSevenSubParamsInCanonicalOrder() {
        let subs = Tool.geometry.subParams
        XCTAssertEqual(
            subs.map(\.id),
            ["vertical", "horizontal", "rotate", "scale", "aspect", "offsetX", "offsetY"])
        XCTAssertTrue(Tool.geometry.isMultiParam)
        XCTAssertEqual(Tool.geometry.defaultSubParamId, "vertical")
    }

    /// No single primary field, so the drag bar has nothing to drive and the
    /// living-slider grid must filter the tool out — `GeometrySection` is its
    /// whole control surface, the same shape Lens / Film / HSL take.
    func testGeometryHasNoPrimaryField() {
        XCTAssertNil(ToolValueMapping.displayRange(for: .geometry))
        XCTAssertTrue(Tool.geometry.isWired)
        XCTAssertEqual(Tool.geometry.group, .detail)
    }

    func testGeometrySubParamsCarryTheGeneratedRangesAndDefaults() {
        let subs = Tool.geometry.subParams
        XCTAssertEqual(subs[0].range, AdjustmentModel.perspectiveVerticalRange)
        XCTAssertEqual(subs[1].range, AdjustmentModel.perspectiveHorizontalRange)
        XCTAssertEqual(subs[2].range, AdjustmentModel.perspectiveRotateRange)
        XCTAssertEqual(subs[3].range, AdjustmentModel.perspectiveScaleRange)
        XCTAssertEqual(subs[4].range, AdjustmentModel.perspectiveAspectRange)
        XCTAssertEqual(subs[5].range, AdjustmentModel.perspectiveXRange)
        XCTAssertEqual(subs[6].range, AdjustmentModel.perspectiveYRange)
        // Every default must be the value that makes its factor the identity,
        // or a reset would leave the frame warped.
        var neutral = AdjustmentModel()
        for sub in subs {
            neutral[keyPath: sub.keyPath] = sub.defaultDisplayValue
        }
        XCTAssertEqual(neutral.perspective, .identity)
    }

    /// Each sub-param must write its OWN member — a copy-paste slip that
    /// pointed two sliders at one field would otherwise be invisible.
    func testEverySubParamWritesADistinctField() {
        var model = AdjustmentModel()
        let subs = Tool.geometry.subParams
        for (index, sub) in subs.enumerated() {
            model[keyPath: sub.keyPath] = Double(index + 1)
        }
        for (index, sub) in subs.enumerated() {
            XCTAssertEqual(
                model[keyPath: sub.keyPath], Double(index + 1),
                "\(sub.id) shares a field with another slider")
        }
    }

    /// The preset bridge must reach every one of the seven, or a copied preset
    /// would silently drop the geometry it was captured with.
    func testPresetBridgeMapsEveryGeometryFieldNameToItsMember() {
        var model = AdjustmentModel()
        let names: [AdjustmentModel.FieldName] = [
            .perspectiveVertical, .perspectiveHorizontal, .perspectiveRotate,
            .perspectiveScale, .perspectiveAspect, .perspectiveX, .perspectiveY,
        ]
        for (index, name) in names.enumerated() {
            let path = try? XCTUnwrap(name.numericKeyPath)
            guard let path else { continue }
            model[keyPath: path] = Double(index + 1)
            XCTAssertNotNil(name.numericRange, "\(name) has no range to clamp against")
        }
        XCTAssertEqual(
            [
                model.perspective.vertical, model.perspective.horizontal,
                model.perspective.rotate, model.perspective.scale,
                model.perspective.aspect, model.perspective.x, model.perspective.y,
            ],
            [1, 2, 3, 4, 5, 6, 7])
    }
}
