// LocalAdjustmentBrushTests.swift — brush-mask XMP I/O, flat wire and
// raster math (#360): the fourth `crs:PaintBasedCorrections` container, a
// `Mask/Paint` leaf whose `crs:Dabs` attribute carries the ordered dab
// series. Split from `LocalAdjustmentXMPTests.swift` the way the Rust
// suite splits `tests_local_adjustments_brush.rs` off its sibling.

import XCTest

@testable import MapleCore

/// Six spaces — the canonical depth for children of `rdf:Description`.
private let brushIndent = "      "

/// The shared fixture (`brush_layer()` in Rust): two paint dabs and one
/// erase dab, a minted digest, and a STAMPED registry id — which must not
/// leak into the sidecar.
private let brushLayer = LocalAdjustment(
    mask: .brush(
        dabs: [
            BrushDab(
                center: MaskPoint(x: 0.25, y: 0.3), radius: 0.05, feather: 0.5, weight: 0.8,
                erase: false),
            BrushDab(
                center: MaskPoint(x: 0.3, y: 0.35), radius: 0.05, feather: 0.5, weight: 0.8,
                erase: false),
            BrushDab(
                center: MaskPoint(x: 0.275, y: 0.325), radius: 0.02, feather: 0, weight: 1,
                erase: true),
        ],
        digest: "0123456789abcdef", rasterId: 7),
    adjustments: PartialAdjustments(exposure: 0.5))

/// Cross-language byte-parity fixture (`CANONICAL_PAINT_BLOCK` in Rust and
/// TypeScript): all three serializers must produce this byte-for-byte from
/// the fixture layer at the same indent. (The C# suite pins only the
/// linear/radial literal: Windows passes paint through unmodelled.)
private let canonicalPaintBlock = """
      <crs:PaintBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description
              crs:What="Correction"
              crs:CorrectionAmount="1"
              crs:CorrectionActive="True"
              crs:LocalExposure2012="0.5">
              <crs:CorrectionMasks>
                <rdf:Seq>
                  <rdf:li
                    crs:What="Mask/Paint"
                    crs:MaskValue="1"
                    crs:Dabs="0.25 0.3 0.05 0.5 0.8 0 0.3 0.35 0.05 0.5 0.8 0 0.275 0.325 0.02 0 1 1"
                    papp:BrushDigest="0123456789abcdef"/>
                </rdf:Seq>
              </crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:PaintBasedCorrections>
"""

/// Wrap a nested child block in a sidecar envelope.
private func brushSidecar(_ children: String) -> String {
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

private func brushTempDirectory() throws -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-xmp-360-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

final class LocalAdjustmentBrushTests: XCTestCase {

    private func withLayers(_ layers: [LocalAdjustment]) -> AdjustmentModel {
        var model = AdjustmentModel()
        model.localAdjustments = layers
        return model
    }

    // MARK: - Cross-language parity

    func testSerializesCanonicalPaintBlockFromAHandBuiltModel() {
        XCTAssertEqual(
            XMPSerializer._buildLocalAdjustmentsBlock(
                model: withLayers([brushLayer]), indent: brushIndent),
            canonicalPaintBlock)
    }

    func testParsesCanonicalPaintBlockIntoTheFixtureLayer() throws {
        let (model, _) = try XMPParser.parse(brushSidecar(canonicalPaintBlock))
        XCTAssertEqual(model.localAdjustments.count, 1)
        guard case .brush(let dabs, let digest, let rasterId) = model.localAdjustments[0].mask
        else { return XCTFail("expected a brush mask") }
        guard case .brush(let wantDabs, _, _) = brushLayer.mask else { return XCTFail("fixture") }
        XCTAssertEqual(dabs, wantDabs)
        XCTAssertEqual(digest, "0123456789abcdef")
        // The registry id never persists: the writer drops it, the parser
        // reads back 0, and the host re-resolves by digest.
        XCTAssertEqual(rasterId, 0)
        XCTAssertEqual(model.localAdjustments[0].adjustments, brushLayer.adjustments)
    }

    /// bytes → model → bytes is the identity function.
    func testRoundTripsCanonicalPaintBlockByteForByte() throws {
        let (model, _) = try XMPParser.parse(brushSidecar(canonicalPaintBlock))
        XCTAssertEqual(
            XMPSerializer._buildLocalAdjustmentsBlock(model: model, indent: brushIndent),
            canonicalPaintBlock)
    }

    /// A paint layer interleaved with other kinds serializes in canonical
    /// container order: linear, radial, paint, group.
    func testPaintContainerSortsBetweenRadialAndGroup() {
        let linear = LocalAdjustment(
            mask: .linear(
                start: MaskPoint(x: 0, y: 0), end: MaskPoint(x: 1, y: 0), feather: 0.5),
            adjustments: PartialAdjustments())
        let everywhere = LocalAdjustment(mask: .everywhere, adjustments: PartialAdjustments())
        let block = XMPSerializer._buildLocalAdjustmentsBlock(
            model: withLayers([everywhere, brushLayer, linear]), indent: brushIndent)
        guard let gradient = block.range(of: "<crs:GradientBasedCorrections>"),
            let paint = block.range(of: "<crs:PaintBasedCorrections>"),
            let group = block.range(of: "<crs:MaskGroupBasedCorrections>")
        else { return XCTFail("all three containers must be emitted: \(block)") }
        XCTAssertLessThan(gradient.lowerBound, paint.lowerBound)
        XCTAssertLessThan(paint.lowerBound, group.lowerBound)
    }

    // MARK: - Whole-document behaviour

    /// The paint container is modeled, not passthrough: a Maple-authored
    /// sidecar parses to an empty node bucket, and a re-save is a fixed point.
    func testRidesTheModelNotThePassthroughBucket() throws {
        let original = XMPSerializer.serialize(
            model: withLayers([brushLayer]), culling: CullingState())
        XCTAssertTrue(original.contains(canonicalPaintBlock), original)

        let passthrough = XMPParser.parsePassthrough(original)
        XCTAssertTrue(passthrough.unknownNodes.isEmpty, "\(passthrough.unknownNodes)")

        let (model, culling) = try XMPParser.parse(original)
        XCTAssertEqual(model.localAdjustments.count, 1)
        XCTAssertEqual(
            XMPSerializer.serialize(model: model, culling: culling, passthrough: passthrough),
            original)
    }

    /// Real files in a temp directory through the on-disk store, per the
    /// no-mocks-for-sidecars rule: load → edit → flush keeps the stroke,
    /// and a second save is a fixed point.
    func testRoundTripsThroughARealSidecarFile() async throws {
        let dir = try brushTempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let rawURL = dir.appendingPathComponent("photo.dng")
        let sidecarURL = SidecarPath.sidecarURL(for: rawURL)
        try brushSidecar(canonicalPaintBlock).write(
            to: sidecarURL, atomically: true, encoding: .utf8)

        let store = XMPSidecarStore(rawURL: rawURL)
        let (model, culling) = try await store.load()
        XCTAssertEqual(model.localAdjustments.count, 1)
        guard case .brush(let dabs, let digest, _) = model.localAdjustments[0].mask else {
            return XCTFail("expected a brush mask")
        }
        XCTAssertEqual(dabs.count, 3)
        XCTAssertEqual(digest, "0123456789abcdef")

        var edited = model
        edited.exposure = 1.25
        await store.update(model: edited, culling: culling)
        await store.flush()
        let first = try String(contentsOf: sidecarURL, encoding: .utf8)
        XCTAssertTrue(first.contains("crs:Exposure2012=\"1.25\""))
        XCTAssertTrue(first.contains(canonicalPaintBlock), first)

        let reopened = XMPSidecarStore(rawURL: rawURL)
        let (reloaded, reloadedCulling) = try await reopened.load()
        XCTAssertEqual(reloaded.localAdjustments.count, 1)
        await reopened.update(model: reloaded, culling: reloadedCulling)
        await reopened.flush()
        XCTAssertEqual(try String(contentsOf: sidecarURL, encoding: .utf8), first)
    }

    // MARK: - Tolerant reader

    private func paintCorrection(
        descriptionAttrs: String = "crs:What=\"Correction\"",
        maskLeaf: String
    ) -> String {
        """
              <crs:PaintBasedCorrections>
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
              </crs:PaintBasedCorrections>
        """
    }

    /// No `crs:Dabs` is an empty stroke (weight 0), not an error.
    func testMissingDabsParsesAsAnEmptyStroke() throws {
        let block = paintCorrection(
            maskLeaf: "<rdf:li crs:What=\"Mask/Paint\" crs:MaskValue=\"1\"/>")
        let (model, _) = try XMPParser.parse(brushSidecar(block))
        XCTAssertEqual(model.localAdjustments.count, 1)
        guard case .brush(let dabs, let digest, let rasterId) = model.localAdjustments[0].mask
        else { return XCTFail("expected a brush mask") }
        XCTAssertTrue(dabs.isEmpty)
        XCTAssertEqual(digest, "")
        XCTAssertEqual(rasterId, 0)
    }

    /// A foreign paint mask — dabs but no Maple digest — loads with an
    /// empty digest; the session recomputes it when it rasterizes.
    func testForeignPaintMaskLoadsWithAnEmptyDigest() throws {
        let block = paintCorrection(
            maskLeaf: "<rdf:li crs:What=\"Mask/Paint\" crs:MaskValue=\"1\" crs:Dabs=\"0.5 0.5 0.1 0.5 1 0\"/>"
        )
        let (model, _) = try XMPParser.parse(brushSidecar(block))
        XCTAssertEqual(model.localAdjustments.count, 1)
        guard case .brush(let dabs, let digest, _) = model.localAdjustments[0].mask else {
            return XCTFail("expected a brush mask")
        }
        XCTAssertEqual(dabs.count, 1)
        XCTAssertEqual(digest, "")
    }

    /// A present-but-malformed series drops the correction (raw-core
    /// hard-errors there; this reader is tolerant like its siblings).
    func testMalformedDabsDropsTheCorrection() throws {
        for leaf in [
            // Five tokens, not a multiple of six.
            "<rdf:li crs:What=\"Mask/Paint\" crs:MaskValue=\"1\" crs:Dabs=\"0.5 0.5 0.1 0.5 1\"/>",
            // Non-numeric token.
            "<rdf:li crs:What=\"Mask/Paint\" crs:MaskValue=\"1\" crs:Dabs=\"0.5 0.5 wide 0.5 1 0\"/>",
            // Erase flag that is neither 0 nor 1.
            "<rdf:li crs:What=\"Mask/Paint\" crs:MaskValue=\"1\" crs:Dabs=\"0.5 0.5 0.1 0.5 1 2\"/>",
        ] {
            let (model, _) = try XMPParser.parse(brushSidecar(paintCorrection(maskLeaf: leaf)))
            XCTAssertTrue(model.localAdjustments.isEmpty, leaf)
        }
    }

    /// A paint leaf in the group container drops the WHOLE group, never
    /// just the component: partial import would widen the region.
    func testPaintLeafInAGroupDropsTheWholeGroup() throws {
        let block = """
              <crs:MaskGroupBasedCorrections>
                <rdf:Seq>
                  <rdf:li>
                    <rdf:Description crs:What="Correction" papp:MaskGroupVersion="1">
                      <crs:CorrectionMasks>
                        <rdf:Seq>
                          <rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroX="0" crs:ZeroY="0" crs:FullX="1" crs:FullY="0" crs:MaskActive="True" crs:MaskBlendMode="0" crs:MaskInverted="False"/>
                          <rdf:li crs:What="Mask/Paint" crs:MaskValue="1" crs:Dabs="0.5 0.5 0.1 0.5 1 0" crs:MaskActive="True" crs:MaskBlendMode="0" crs:MaskInverted="False"/>
                        </rdf:Seq>
                      </crs:CorrectionMasks>
                    </rdf:Description>
                  </rdf:li>
                </rdf:Seq>
              </crs:MaskGroupBasedCorrections>
        """
        let (model, _) = try XMPParser.parse(brushSidecar(block))
        XCTAssertTrue(model.localAdjustments.isEmpty)
    }

    /// A paint leaf outside the paint container is not a brush mask.
    func testPaintWhatInAGradientContainerIsDropped() throws {
        let block = """
              <crs:GradientBasedCorrections>
                <rdf:Seq>
                  <rdf:li>
                    <rdf:Description crs:What="Correction">
                      <crs:CorrectionMasks>
                        <rdf:Seq>
                          <rdf:li crs:What="Mask/Paint" crs:MaskValue="1" crs:Dabs="0.5 0.5 0.1 0.5 1 0"/>
                        </rdf:Seq>
                      </crs:CorrectionMasks>
                    </rdf:Description>
                  </rdf:li>
                </rdf:Seq>
              </crs:GradientBasedCorrections>
        """
        let (model, _) = try XMPParser.parse(brushSidecar(block))
        XCTAssertTrue(model.localAdjustments.isEmpty)
    }

    // MARK: - Flat wire

    /// A brush encodes as a bitmap record carrying the registry id —
    /// mirror of raw-core's `write_mask` brush arm.
    func testBrushEncodesAsABitmapRecord() {
        let flat = LocalAdjustmentFlat.toFlat([brushLayer])
        XCTAssertEqual(flat.count, LocalAdjustmentFlat.layerFloatLen)
        XCTAssertEqual(flat[2], 7)
        XCTAssertEqual(flat[6], LocalMaskWire.kindBitmap)
    }

    /// A bitmap record decodes as `.bitmap` even when a brush wrote it:
    /// render-equivalent (same registered raster), since the flat wire
    /// carries no dabs.
    func testBrushDecodesBackAsABitmap() {
        let flat = LocalAdjustmentFlat.toFlat([brushLayer])
        let layers = LocalAdjustmentFlat.fromFlat(flat, rasterDigests: [7: "0123456789abcdef"])
        XCTAssertEqual(layers.count, 1)
        guard case .bitmap(let recipe, let rasterId) = layers[0].mask else {
            return XCTFail("expected a bitmap mask")
        }
        XCTAssertEqual(recipe.digest, "0123456789abcdef")
        XCTAssertEqual(rasterId, 7)
    }

    // MARK: - Group rejection

    func testMaskComponentRejectsBrush() {
        guard case .brush = brushLayer.mask else { return XCTFail("fixture") }
        XCTAssertNil(MaskComponent(mask: brushLayer.mask))
        var component = MaskComponent(
            mask: .everywhere, combine: .add, invert: false)!
        XCTAssertFalse(component.replaceMask(brushLayer.mask))
        XCTAssertEqual(component.mask, .everywhere)
    }

    // MARK: - Raster math

    func testDigestIsAStableContentHash() {
        guard case .brush(let dabs, _, _) = brushLayer.mask else { return XCTFail("fixture") }
        let digest = BrushRaster.digest(dabs)
        XCTAssertTrue(digest.range(of: "^[0-9a-f]{16}$", options: .regularExpression) != nil, digest)
        XCTAssertEqual(BrushRaster.digest(dabs), digest)
        XCTAssertNotEqual(BrushRaster.digest(Array(dabs.dropFirst())), digest)
        XCTAssertNotEqual(BrushRaster.digest([]), digest)
    }

    func testRasterDimsHoldThe1024LongEdge() {
        XCTAssertEqual(BrushRaster.rasterDims(imageWidth: 6000, imageHeight: 4000).width, 1024)
        XCTAssertEqual(BrushRaster.rasterDims(imageWidth: 6000, imageHeight: 4000).height, 682)
        XCTAssertEqual(BrushRaster.rasterDims(imageWidth: 4000, imageHeight: 6000).width, 682)
        XCTAssertEqual(BrushRaster.rasterDims(imageWidth: 4000, imageHeight: 6000).height, 1024)
        XCTAssertEqual(BrushRaster.rasterDims(imageWidth: 0, imageHeight: 0).width, 1024)
        XCTAssertEqual(BrushRaster.rasterDims(imageWidth: 0, imageHeight: 0).height, 1024)
    }

    /// Stamping through the FFI entry peaks at the dab weight on its
    /// centre texel — the same vector the Rust and TypeScript suites pin.
    func testRasterizePeaksAtTheDabWeight() {
        let dabs = [
            BrushDab(
                center: MaskPoint(x: 0.5, y: 0.5), radius: 0.2, feather: 0.5, weight: 0.6,
                erase: false)
        ]
        guard let bytes = BrushRaster.rasterize(dabs: dabs, width: 101, height: 101) else {
            return XCTFail("rasterize rejected a well-formed pack")
        }
        XCTAssertEqual(bytes.count, 101 * 101)
        XCTAssertEqual(bytes[50 * 101 + 50], UInt8((0.6 * 255).rounded()))
    }

    /// A tap stamps one dab; a drag lays spacing-separated centres without
    /// re-stamping the segment start. Same vectors as the TypeScript suite
    /// (`mask-brush.spec.ts` "stroke capture").
    func testInterpolateDabsSpacesTheStroke() {
        let tap = BrushRaster.interpolateDabs(
            from: MaskPoint(x: 0.5, y: 0.5), to: MaskPoint(x: 0.5, y: 0.5), aspect: 1.5,
            radius: 0.05, feather: 0.5, weight: 0.8, erase: false)
        XCTAssertEqual(tap.count, 1)
        XCTAssertEqual(tap[0].center, MaskPoint(x: 0.5, y: 0.5))
        let drag = BrushRaster.interpolateDabs(
            from: MaskPoint(x: 0.1, y: 0.5), to: MaskPoint(x: 0.2, y: 0.5), aspect: 1,
            radius: 0.05, feather: 0.5, weight: 0.8, erase: false)
        // 0.1 wide in width-fractions at 0.0125 spacing → 8 dabs, ending on `to`.
        XCTAssertEqual(drag.count, 8)
        XCTAssertEqual(drag.first?.center.x ?? -1, 0.1125, accuracy: 1e-9)
        XCTAssertEqual(drag.last?.center.x ?? -1, 0.2, accuracy: 1e-12)
        XCTAssertEqual(drag.last?.center.y ?? -1, 0.5, accuracy: 1e-12)
    }

    /// `MaskWeight` samples a brush's registered raster, and an
    /// unresolved brush reads 0 like an unresolved bitmap.
    func testMaskWeightSamplesTheRegisteredRaster() {
        let rasters: [UInt32: MaskRasterStore.Raster] = [9: (2, 2, [0, 255, 255, 0])]
        let resolved = LocalMask.brush(dabs: [], digest: "d", rasterId: 9)
        XCTAssertEqual(MaskWeight.evaluate(resolved, x: 1, y: 0, rasters: rasters), 1)
        XCTAssertEqual(MaskWeight.evaluate(resolved, x: 0, y: 0, rasters: rasters), 0)
        XCTAssertEqual(MaskWeight.evaluate(resolved, x: 0.5, y: 0.5, rasters: rasters), 0.5)
        let unresolved = LocalMask.brush(dabs: [], digest: "", rasterId: 0)
        XCTAssertEqual(MaskWeight.evaluate(unresolved, x: 0.5, y: 0.5, rasters: rasters), 0)
        XCTAssertEqual(MaskWeight.evaluate(resolved, x: 0.5, y: 0.5, rasters: [:]), 0)
    }
}
