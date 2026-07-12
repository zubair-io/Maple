// WbScaleVersionTests.swift — WB slider-scale versioning
// (#1780/#1875/#1893/#1894).
//
// Mirrors the Rust tests in `raw-core/src/xmp/tests_wb_scale.rs` and the
// web tests in `maple-common/src/lib/xmp/wb-scale-version.spec.ts`:
//
//  - explicit `papp:WbScaleVersion` stamp wins;
//  - Maple-authored sidecar (papp namespace present) with no stamp is
//    version 1 (pre-#1756 scale);
//  - non-Maple sidecar (no papp namespace — ACR/Lightroom-authored) is
//    version 5 (ACR's own convention: the Robertson `dng_temperature`
//    mapping ACR's slider natively evaluates, #1894);
//  - V2/V3/V4 stamps (the legacy Hernández-Andrés daylight-locus scales)
//    load-normalize: the authored `(temperature, tint)` PAIR converts
//    jointly through physical chromaticity
//    (`WbDngTemperature.authoredPairToV5`) and the model becomes V5;
//  - the serializer always stamps (it always writes explicit
//    Temperature/Tint) as {1, 5}, so a V1 sidecar's stored values keep
//    their meaning across saves and everything else is V5.
//
// Sidecar-layer rule: no mocks — the store round-trip below goes through
// real `.xmp` files in a temp directory.

import XCTest
@testable import MapleCore

final class WbScaleVersionTests: XCTestCase {

    private func mapleSidecar(_ attrs: String) -> String {
        """
        <?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description
              xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              xmlns:xmp="http://ns.adobe.com/xap/1.0/"
              xmlns:papp="http://ns.justmaple.app/1.0/"
              \(attrs)/>
          </rdf:RDF>
        </x:xmpmeta>
        <?xpacket end="w"?>
        """
    }

    private func acrSidecar(_ attrs: String) -> String {
        """
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
         <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description rdf:about=""
            xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
           \(attrs)/>
         </rdf:RDF>
        </x:xmpmeta>
        """
    }

    func testDefaultModelIsVersion5() {
        XCTAssertEqual(AdjustmentModel.default.wbScaleVersion, 5,
                       "fresh models author in the current (Robertson, #1894) scale")
    }

    func testMapleAuthoredWithoutStampParsesAsVersion1() throws {
        let (m, _) = try XMPParser.parse(
            mapleSidecar(#"crs:Temperature="6282" crs:Tint="-44""#))
        XCTAssertEqual(m.wbScaleVersion, 1)
        XCTAssertEqual(m.temperature, 6282)
        XCTAssertEqual(m.tint, -44)
    }

    func testAcrAuthoredWithoutPappParsesAsVersion5() throws {
        // ACR's crs:Tint is already expressed in ACR's own Robertson
        // convention — passes through unconverted (#1894).
        let (m, _) = try XMPParser.parse(
            acrSidecar(#"crs:Temperature="5500" crs:Tint="10""#))
        XCTAssertEqual(m.wbScaleVersion, 5)
        XCTAssertEqual(m.tint, 10)
    }

    func testExplicitStampWinsOverHeuristic() throws {
        // A V2 stamp wins over the V1 authorship heuristic, then
        // load-normalizes to 5. The pair converts jointly even though only
        // temperature was authored (#1894: the legacy and Robertson loci
        // diverge, so a temperature-only value still moves) — pinned
        // against the Rust reference's `authored_pair_to_v5(5700, 0, V2)`.
        let (m, _) = try XMPParser.parse(
            mapleSidecar(#"crs:Temperature="5700" papp:WbScaleVersion="2""#))
        XCTAssertEqual(m.wbScaleVersion, 5)
        XCTAssertEqual(m.temperature, 5697.007, accuracy: 0.05)
        XCTAssertEqual(m.tint, 11.083624, accuracy: 0.005)
    }

    func testV2AuthoredPairConvertsJointlyIntoV5OnLoad() throws {
        // #1894: a V2 sidecar's authored pair converts through the legacy
        // (negated + 0.3-rescaled) locus map and back through Robertson —
        // pinned against the Rust reference's
        // `authored_pair_to_v5(5700, 50, V2)`.
        let (m, _) = try XMPParser.parse(
            mapleSidecar(#"crs:Temperature="5700" crs:Tint="50" papp:WbScaleVersion="2""#))
        XCTAssertEqual(m.wbScaleVersion, 5)
        XCTAssertEqual(m.temperature, 5696.3936, accuracy: 0.05)
        XCTAssertEqual(m.tint, -3.9181564, accuracy: 0.005)
    }

    func testV3AuthoredPairConvertsJointlyIntoV5OnLoad() throws {
        // #1894: V3 is the ACR-direction legacy scale at the 1e-4
        // magnitude — pinned against the Rust reference's
        // `authored_pair_to_v5(5520, -144, V3)`.
        let (m, _) = try XMPParser.parse(
            mapleSidecar(#"crs:Temperature="5520" crs:Tint="-144" papp:WbScaleVersion="3""#))
        XCTAssertEqual(m.wbScaleVersion, 5)
        XCTAssertEqual(m.temperature, 5526.068, accuracy: 0.05)
        XCTAssertEqual(m.tint, -32.580647, accuracy: 0.005)
    }

    func testV4AuthoredPairConvertsJointlyIntoV5OnLoad() throws {
        // #1894: V4 kept ACR's kTintScale magnitude but still evaluated the
        // legacy Hernández-Andrés locus (#1893) — it no longer passes
        // through unconverted now that V5 evaluates Robertson instead;
        // pinned against the Rust reference's
        // `authored_pair_to_v5(5520, -53, V4)`.
        let (m, _) = try XMPParser.parse(
            mapleSidecar(#"crs:Temperature="5520" crs:Tint="-53" papp:WbScaleVersion="4""#))
        XCTAssertEqual(m.wbScaleVersion, 5)
        XCTAssertEqual(m.temperature, 5526.5674, accuracy: 0.05)
        XCTAssertEqual(m.tint, -42.379494, accuracy: 0.005)
    }

    func testNormalizedFractionalPairSurvivesResaveStably() throws {
        // PR #1900 review: the writer serialized WB with %.0f. A
        // V3-authored (5520, −144) normalizes to the fractional V5 pair
        // (5526.068, −32.5806…); integer rounding would shift the stored
        // WB on every re-save and drift the rendered look. The wire format
        // carries 2 decimals, and a SECOND save generation must be
        // byte-stable (parse → save → parse → save reaches a fixed point
        // after the first 2-decimal quantization).
        let (m, c) = try XMPParser.parse(
            mapleSidecar(#"crs:Temperature="5520" crs:Tint="-144" papp:WbScaleVersion="3""#))
        XCTAssertEqual(m.tint, -32.580647, accuracy: 0.005)
        let resaved = XMPSerializer.serialize(model: m, culling: c)
        XCTAssertTrue(resaved.contains(#"crs:Tint="-32.58""#),
                      "fractional tint must serialize without integer rounding")
        // The converted temperature is fractional (≈5526.09); assert the
        // wire form is fmtWb of the model value rather than pinning the
        // last digit of the conversion itself (its own value is pinned by
        // testV3AuthoredPairConvertsJointlyIntoV5OnLoad).
        XCTAssertTrue(resaved.contains("crs:Temperature=\"\(XMPSerializer.fmtWb(m.temperature))\""),
                      "fractional temperature must serialize without integer rounding")
        XCTAssertNotEqual(XMPSerializer.fmtWb(m.temperature), "5526",
                          "the converted temperature must not integer-round")
        let (reparsed, c2) = try XMPParser.parse(resaved)
        XCTAssertEqual(reparsed.wbScaleVersion, 5)
        XCTAssertEqual(reparsed.tint, -32.58, accuracy: 1e-9)
        let secondGeneration = XMPSerializer.serialize(model: reparsed, culling: c2)
        XCTAssertTrue(secondGeneration.contains(#"crs:Tint="-32.58""#),
                      "the 2-decimal quantization must be a save fixed point, not a drift")
    }

    func testFractionalTemperatureBeyondSixSignificantDigitsSurvives() {
        // PR #1900 review (Jules): %g defaults to 6 significant digits, so
        // an 11500.25 K fractional temperature would silently truncate to
        // "11500.2" and drift on re-save. fmtWb must carry the full
        // 2-decimal precision at any slider magnitude.
        var m = AdjustmentModel.default
        m.temperature = 11500.25
        m.tint = -43.25
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"crs:Temperature="11500.25""#),
                      "7-significant-digit fractional temperature must not truncate")
        XCTAssertTrue(xml.contains(#"crs:Tint="-43.25""#))
    }

    func testSerializerAlwaysStampsTheModelsVersion() {
        // This serializer writes explicit Temperature/Tint unconditionally,
        // so the stamp rides along unconditionally too.
        let fresh = XMPSerializer.serialize(model: .default, culling: CullingState())
        XCTAssertTrue(fresh.contains(#"papp:WbScaleVersion="5""#))

        var v1 = AdjustmentModel.default
        v1.temperature = 6282
        v1.tint = -44
        v1.wbScaleVersion = 1
        let stamped = XMPSerializer.serialize(model: v1, culling: CullingState())
        XCTAssertTrue(
            stamped.contains(#"papp:WbScaleVersion="1""#),
            "a V1-loaded model must re-stamp 1 — upgrading the tag without converting the numbers reintroduces the #1780 pink"
        )
    }

    func testSerializerClampsOutOfRangeVersionTo5() {
        // raw-core's parser hard-fails on an unknown stamp — a corrupted
        // model field must never produce an unparseable sidecar.
        var corrupted = AdjustmentModel.default
        corrupted.wbScaleVersion = 9
        let xml = XMPSerializer.serialize(model: corrupted, culling: CullingState())
        XCTAssertTrue(xml.contains(#"papp:WbScaleVersion="5""#))
        XCTAssertFalse(xml.contains(#"papp:WbScaleVersion="9""#))
    }

    /// Real-file round trip through the sidecar store: a pre-#1756
    /// Maple-authored `.xmp` on disk loads as version 1, and a re-save of
    /// that model writes an explicit `papp:WbScaleVersion="1"` so the
    /// values keep their meaning for every future reader.
    func testSidecarStoreRoundTripPreservesVersion1() async throws {
        let tmpRaw = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        let xmpURL = tmpRaw.deletingPathExtension().appendingPathExtension("xmp")
        defer { try? FileManager.default.removeItem(at: xmpURL) }

        try mapleSidecar(#"crs:Temperature="6282" crs:Tint="-44""#)
            .write(to: xmpURL, atomically: true, encoding: .utf8)

        let store = XMPSidecarStore(rawURL: tmpRaw)
        let (loaded, culling) = try await store.load()
        XCTAssertEqual(loaded.wbScaleVersion, 1)
        XCTAssertEqual(loaded.temperature, 6282)

        await store.update(model: loaded, culling: culling)
        await store.flush()

        let rewritten = try String(contentsOf: xmpURL, encoding: .utf8)
        XCTAssertTrue(rewritten.contains(#"papp:WbScaleVersion="1""#))
        XCTAssertTrue(rewritten.contains(#"crs:Temperature="6282""#))

        // And a fresh store (no in-memory cache) still reads it as V1.
        let fresh = XMPSidecarStore(rawURL: tmpRaw)
        let (reloaded, _) = try await fresh.load()
        XCTAssertEqual(reloaded.wbScaleVersion, 1)
        XCTAssertEqual(reloaded.tint, -44)
    }
}
