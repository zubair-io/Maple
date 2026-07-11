// WbScaleVersionTests.swift — WB slider-scale versioning
// (#1780/#1875/#1893).
//
// Mirrors the Rust tests in `raw-core/src/xmp/tests_wb_scale.rs` and the
// web tests in `maple-common/src/lib/xmp/wb-scale-version.spec.ts`:
//
//  - explicit `papp:WbScaleVersion` stamp wins;
//  - Maple-authored sidecar (papp namespace present) with no stamp is
//    version 1 (pre-#1756 scale);
//  - non-Maple sidecar (no papp namespace — ACR/Lightroom-authored) is
//    version 4 (ACR's own convention: the #1875 direction and the #1893
//    kTintScale magnitude);
//  - V2/V3 stamps (the legacy 1e-4-magnitude scales; V2's tint axis was
//    also inverted vs ACR) load-normalize: authored tint rescales by 0.3
//    (negating for V2) and the model becomes V4;
//  - the serializer always stamps (it always writes explicit
//    Temperature/Tint) as {1, 4}, so a V1 sidecar's stored values keep
//    their meaning across saves and everything else is V4.
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

    func testDefaultModelIsVersion4() {
        XCTAssertEqual(AdjustmentModel.default.wbScaleVersion, 4,
                       "fresh models author in the current (ACR direction + kTintScale) scale")
    }

    func testMapleAuthoredWithoutStampParsesAsVersion1() throws {
        let (m, _) = try XMPParser.parse(
            mapleSidecar(#"crs:Temperature="6282" crs:Tint="-44""#))
        XCTAssertEqual(m.wbScaleVersion, 1)
        XCTAssertEqual(m.temperature, 6282)
        XCTAssertEqual(m.tint, -44)
    }

    func testAcrAuthoredWithoutPappParsesAsVersion4() throws {
        // ACR's crs:Tint is already in the V4 direction AND magnitude —
        // passes through unconverted (#1893).
        let (m, _) = try XMPParser.parse(
            acrSidecar(#"crs:Temperature="5500" crs:Tint="10""#))
        XCTAssertEqual(m.wbScaleVersion, 4)
        XCTAssertEqual(m.tint, 10)
    }

    func testExplicitStampWinsOverHeuristic() throws {
        // A V2 stamp wins over the V1 authorship heuristic, then
        // load-normalizes to 4 (no authored tint here, so no conversion).
        let (m, _) = try XMPParser.parse(
            mapleSidecar(#"crs:Temperature="5700" papp:WbScaleVersion="2""#))
        XCTAssertEqual(m.wbScaleVersion, 4)
        XCTAssertEqual(m.tint, 0)
    }

    func testV2AuthoredTintNegatesAndRescalesIntoV4OnLoad() throws {
        // #1875 axis + #1893 scale: a V2 sidecar's authored +50 (a
        // green-ward look when written, at the 1e-4 magnitude) must load
        // as -50 x 0.3 = -15 in the V4 (kTintScale) scale so the rendered
        // look is preserved, and the model normalizes to version 4 for
        // every re-save.
        let (m, _) = try XMPParser.parse(
            mapleSidecar(#"crs:Temperature="5700" crs:Tint="50" papp:WbScaleVersion="2""#))
        XCTAssertEqual(m.wbScaleVersion, 4)
        XCTAssertEqual(m.tint, -15.0, accuracy: 1e-9)
        XCTAssertEqual(m.temperature, 5700)
    }

    func testV3AuthoredTintRescalesIntoV4OnLoad() throws {
        // #1893: V3 is the ACR direction at the legacy 1e-4 magnitude —
        // the authored value rescales by 0.3 so its uv displacement is
        // preserved.
        let (m, _) = try XMPParser.parse(
            mapleSidecar(#"crs:Temperature="5520" crs:Tint="-144" papp:WbScaleVersion="3""#))
        XCTAssertEqual(m.wbScaleVersion, 4)
        XCTAssertEqual(m.tint, -43.2, accuracy: 1e-9)
    }

    func testV4StampedTintPassesThroughUnconverted() throws {
        let (m, _) = try XMPParser.parse(
            mapleSidecar(#"crs:Temperature="5520" crs:Tint="-53" papp:WbScaleVersion="4""#))
        XCTAssertEqual(m.wbScaleVersion, 4)
        XCTAssertEqual(m.tint, -53)
    }

    func testSerializerAlwaysStampsTheModelsVersion() {
        // This serializer writes explicit Temperature/Tint unconditionally,
        // so the stamp rides along unconditionally too.
        let fresh = XMPSerializer.serialize(model: .default, culling: CullingState())
        XCTAssertTrue(fresh.contains(#"papp:WbScaleVersion="4""#))

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

    func testSerializerClampsOutOfRangeVersionTo4() {
        // raw-core's parser hard-fails on an unknown stamp — a corrupted
        // model field must never produce an unparseable sidecar.
        var corrupted = AdjustmentModel.default
        corrupted.wbScaleVersion = 7
        let xml = XMPSerializer.serialize(model: corrupted, culling: CullingState())
        XCTAssertTrue(xml.contains(#"papp:WbScaleVersion="4""#))
        XCTAssertFalse(xml.contains(#"papp:WbScaleVersion="7""#))
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
