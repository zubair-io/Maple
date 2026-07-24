// XMPSerializationAutoExposureTests.swift — #1387 companion to
// XMPSerializationTests.swift (split out to stay under the 600-line hard
// budget, CONTRIBUTING.md § "File-size budget" — same rationale as
// EditSessionDecodedCacheAutoExposureTests.swift).
//
// Covers `papp:AutoExposure` — the decode-time scalar mid-gray anchor gain
// mirrored into the Swift `AdjustmentModel` by this ticket. See
// `AdjustmentModel.AutoExposureMode` and `XMPSerialization+Attrs.swift` for
// the write side, `XMPSerialization.swift` for the parse side.

import XCTest
@testable import MapleCore

final class XMPSerializationAutoExposureTests: XCTestCase {

    /// `papp:AutoExposure` parses case-insensitively onto the model;
    /// unknown values keep the default rather than erroring the whole
    /// sidecar (Apple parser convention — mirrors `papp:HotPixelSuppression`
    /// and raw-core's own `"on" | "On"` / `"off" | "Off"` match).
    func testParseAutoExposure() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: #"papp:AutoExposure="Off""#))
        XCTAssertEqual(m.autoExposure, .off)
        let (m2, _) = try XMPParser.parse(xmp(attrs: #"papp:AutoExposure="on""#))
        XCTAssertEqual(m2.autoExposure, .on)
        let (m3, _) = try XMPParser.parse(xmp(attrs: #"papp:AutoExposure="Maybe""#))
        XCTAssertEqual(m3.autoExposure, .on, "unknown value keeps the default")
    }

    /// A sidecar predating #1387 (no `papp:AutoExposure` attribute at all)
    /// must parse to the default `.on` — matches raw-core's own parse
    /// default so a sidecar written before this field existed doesn't
    /// silently change behavior on next open.
    func testParseAutoExposureAbsentDefaultsToOn() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: #"crs:Exposure2012="1.0""#))
        XCTAssertEqual(m.autoExposure, .on)
    }

    /// AutoExposure round-trips through serialize → parse, and the default
    /// (`.on`) emits no attribute so sidecars predating this field stay
    /// byte-identical.
    func testAutoExposureRoundTripAndDefaultOmission() throws {
        var m = AdjustmentModel()
        m.autoExposure = .off
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"papp:AutoExposure="Off""#))
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.autoExposure, .off)

        let defaultXml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(defaultXml.contains("papp:AutoExposure"),
                       "default .on must not be serialized")
    }

    /// The decode-baked field must survive `stripAppleGPUStages` — `auto_exposure`
    /// is a decode-time scalar gain with no Apple-Metal live re-apply, same
    /// #950 baked-model cache-key contract as `hotPixelSuppression` /
    /// `chromaPrefilter`.
    func testStripKeepsAutoExposure() {
        var m = AdjustmentModel()
        m.autoExposure = .off
        let stripped = RawCoreBridge.stripAppleGPUStages(m)
        XCTAssertEqual(stripped.autoExposure, .off,
                       "stripAppleGPUStages must keep the decode-baked autoExposure")
    }

    /// `XMPSidecarStore` write → read carries `autoExposure` across the
    /// REAL on-disk `.xmp` boundary (no mocks — see CLAUDE.md § "No mocks
    /// for the sidecar layer"), mirroring
    /// `XMPSerializationTests.testSidecarStoreRoundTripKeywords`.
    /// Regression coverage for #1387: before this ticket the field didn't
    /// exist on the Swift model at all, so a `Profile.neutral` sidecar
    /// carrying `autoExposure = .off` (written by AUTO) would silently lose
    /// it on the next Apple save.
    func testSidecarStoreRoundTripAutoExposure() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        defer {
            let xmpURL = tmp.deletingPathExtension().appendingPathExtension("xmp")
            try? FileManager.default.removeItem(at: xmpURL)
        }

        var m = AdjustmentModel()
        m.profile = .neutral
        m.autoExposure = .off

        let store = XMPSidecarStore(rawURL: tmp)
        await store.update(model: m, culling: CullingState())
        await store.flush()

        // Drop the in-memory cache so the read actually goes to disk.
        let fresh = XMPSidecarStore(rawURL: tmp)
        let (m2, _) = try await fresh.load()
        XCTAssertEqual(m2.autoExposure, .off)
        XCTAssertEqual(m2.profile, .neutral)
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
