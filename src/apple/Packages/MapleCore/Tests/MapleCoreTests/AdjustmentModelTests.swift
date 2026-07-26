import XCTest
@testable import MapleCore

final class AdjustmentModelTests: XCTestCase {

    // MARK: - Defaults

    func testDefaultTemperature() { XCTAssertEqual(AdjustmentModel.default.temperature, 6500) }
    func testDefaultExposure() { XCTAssertEqual(AdjustmentModel.default.exposure, 0) }
    func testDefaultNrColor() { XCTAssertEqual(AdjustmentModel.default.nrColor, 25) }
    func testDefaultHighlightRecovery() {
        // #335 flipped the default to `.chromaticAdaptation` after a
        // re-measured Off-vs-CA harness diff. Users can opt out per-image
        // via `papp:HighlightRecoveryMode="Off"` in the XMP sidecar.
        XCTAssertEqual(AdjustmentModel.default.highlightRecovery, .chromaticAdaptation)
    }

    /// Ticket 12 Bug 3 / #326 — first-open of a sidecar-less RAW must apply
    /// the reference renderer's import baseline (Sharpness=40, Radius=1.0)
    /// so the preview is no softer than the reference renderer's. Apple
    /// historically carried a 45/1.0 override; #326 converges all platforms
    /// onto the canonical 40/1.0 reference values.
    func testDefaultSharpeningMatchesReferenceRawProfile() {
        XCTAssertEqual(AdjustmentModel.default.sharpenAmount, 40)
        XCTAssertEqual(AdjustmentModel.default.sharpenRadius, 1.0)
    }

    /// Capture sharpening (#271) ships off by default so the parity harness
    /// stays bit-identical to pre-#271 behaviour. Per-camera defaults are a
    /// follow-up calibration ticket.
    func testDefaultCaptureSharpeningIsOff() {
        XCTAssertEqual(AdjustmentModel.default.captureSharpeningAmount, 0)
        XCTAssertEqual(AdjustmentModel.default.captureSharpeningSigma, 1.0)
    }

    /// Canonical `papp:CaptureSharpeningSigma` parses into the sigma field.
    func testParseCaptureSharpeningSigmaAttribute() throws {
        let xml = xmp(attrs: #"papp:CaptureSharpeningAmount="65" papp:CaptureSharpeningSigma="2.0""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.captureSharpeningAmount, 65)
        XCTAssertEqual(m.captureSharpeningSigma, 2.0, accuracy: 0.01)
    }

    /// Legacy `papp:CaptureSharpeningRadius` is read-only (#456) — parses
    /// into `captureSharpeningSigma` unchanged so older sidecars still load.
    func testParseLegacyCaptureSharpeningRadiusAttribute() throws {
        let xml = xmp(attrs: #"papp:CaptureSharpeningAmount="65" papp:CaptureSharpeningRadius="1.5""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.captureSharpeningAmount, 65)
        XCTAssertEqual(m.captureSharpeningSigma, 1.5, accuracy: 0.01)
    }

    /// When both keys are present, `papp:CaptureSharpeningSigma` wins
    /// regardless of attribute order — matches raw-core's `sigma_seen`
    /// precedence (#463).
    func testParseCaptureSharpeningSigmaWinsOverRadius() throws {
        let xml = xmp(attrs: #"papp:CaptureSharpeningRadius="1.5" papp:CaptureSharpeningSigma="2.0""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.captureSharpeningSigma, 2.0, accuracy: 0.01)
    }

    /// Round-trip: writes canonical `papp:CaptureSharpeningSigma`, never
    /// the legacy `papp:CaptureSharpeningRadius` (#464).
    func testCaptureSharpeningSigmaRoundTrip() throws {
        var m = AdjustmentModel()
        m.captureSharpeningAmount = 55
        m.captureSharpeningSigma = 2.0
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        // `"2"`, not `"2.0"`: since #1577 every numeric attribute goes
        // through the canonical wire codec, which emits integers bare.
        XCTAssertTrue(xml.contains(#"papp:CaptureSharpeningSigma="2""#),
                      "serializer must emit the canonical sigma key")
        XCTAssertFalse(xml.contains("papp:CaptureSharpeningRadius"),
                       "serializer must not emit the legacy radius key")
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.captureSharpeningAmount, 55)
        XCTAssertEqual(m2.captureSharpeningSigma, 2.0, accuracy: 0.01)
    }

    // MARK: - XMP Parse

    func testParseExposure() throws {
        let xml = xmp(attrs: #"crs:Exposure2012="1.50""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.exposure, 1.50, accuracy: 0.01)
    }

    func testParseContrast() throws {
        let xml = xmp(attrs: #"crs:Contrast2012="100""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.contrast, 100)
    }

    func testParseVibrance() throws {
        let xml = xmp(attrs: #"crs:Vibrance="75""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.vibrance, 75)
    }

    func testParseDehaze() throws {
        let xml = xmp(attrs: #"crs:Dehaze="100""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.dehaze, 100)
    }

    func testParseWBDaylight() throws {
        let xml = xmp(attrs: #"crs:WhiteBalance="Daylight""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.temperature, 5500, accuracy: 1)
        XCTAssertEqual(m.tint, 10, accuracy: 0.1)
    }

    func testParseExplicitTempOverridesPreset() throws {
        let xml = xmp(attrs: #"crs:WhiteBalance="Daylight" crs:Temperature="3200""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.temperature, 3200, accuracy: 1)
    }

    func testParseHighlightRecoveryBlend() throws {
        let xml = xmp(attrs: #"papp:HighlightRecoveryMode="Blend""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.highlightRecovery, .blend)
    }

    /// #335 review: Rust parser accepts both `"chromaticadaptation"` and
    /// `"ChromaticAdaptation"` (and likewise for the legacy variants).
    /// Swift's case-insensitive table needs to match so sidecars that parse
    /// fine on Rust/Web don't silently fall through to the default on Apple.
    func testParseHighlightRecoveryLowercaseChromaticAdaptation() throws {
        let xml = xmp(attrs: #"papp:HighlightRecoveryMode="chromaticadaptation""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.highlightRecovery, .chromaticAdaptation)
    }

    func testParseHighlightRecoveryLowercaseOff() throws {
        let xml = xmp(attrs: #"papp:HighlightRecoveryMode="off""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.highlightRecovery, .off)
    }

    // MARK: - DisplayLookCurve (ticket #371)

    /// New users get the empirical Look (`.default`), not `.neutral`.
    func testDefaultLook() {
        XCTAssertEqual(AdjustmentModel.default.look, .default)
    }

    func testParseLookNeutral() throws {
        let xml = xmp(attrs: #"papp:Look="Neutral""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.look, .neutral)
    }

    func testParseLookDefaultExplicit() throws {
        let xml = xmp(attrs: #"papp:Look="Default""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.look, .default)
    }

    func testParseLookLowercase() throws {
        let xml = xmp(attrs: #"papp:Look="neutral""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.look, .neutral)
    }

    /// Absent attribute -> default (`.default`) so existing sidecars pick
    /// up the empirical Look automatically.
    func testParseLookAbsentDefaultsToDefault() throws {
        let xml = xmp(attrs: #"crs:Exposure2012="0""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.look, .default)
    }

    func testLookRoundTripNeutral() throws {
        var m = AdjustmentModel()
        m.look = .neutral
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.look, .neutral)
    }

    /// `.default` round-trips even though the serializer skips the
    /// attribute on the canonical default — the parser fills the field
    /// with `.default` automatically.
    func testLookRoundTripDefault() throws {
        var m = AdjustmentModel()
        m.look = .default
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertFalse(xml.contains("papp:Look"), "Default Look should be omitted from sidecar")
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.look, .default)
    }

    // MARK: - Profile (Auto Profile Phase 1, ticket #536)

    /// New users land on `.auto` — newly-written sidecars omit
    /// `papp:Profile` and absent-attribute sidecars also land on `.auto`.
    func testDefaultProfile() {
        XCTAssertEqual(AdjustmentModel.default.profile, .auto)
    }

    func testParseProfileNeutral() throws {
        let xml = xmp(attrs: #"papp:Profile="Neutral""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.profile, .neutral)
    }

    func testParseProfileAutoExplicit() throws {
        let xml = xmp(attrs: #"papp:Profile="Auto""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.profile, .auto)
    }

    /// Legacy `papp:Profile="AcrMatch"` (#1722, retired in #2312) migrates
    /// to `.auto` — the profile that superseded it. Sidecars carrying the
    /// retired value came from `maple-cli --profile acr-match` or were
    /// hand-authored, so they must keep parsing. Mirrors raw-core's arm in
    /// `xmp/fields.rs` and the web parser's fallback.
    func testParseRetiredAcrMatchProfileMigratesToAuto() throws {
        let xml = xmp(attrs: #"papp:Profile="AcrMatch""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.profile, .auto)
    }

    /// Case-insensitive parse mirrors `papp:HighlightRecoveryMode` and
    /// raw-core's parser (which uses `eq_ignore_ascii_case`).
    func testParseProfileLowercase() throws {
        let xml = xmp(attrs: #"papp:Profile="neutral""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.profile, .neutral)
    }

    /// Absent attribute -> default (`.auto`).
    func testParseProfileAbsentDefaultsToAuto() throws {
        let xml = xmp(attrs: #"crs:Exposure2012="0""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.profile, .auto)
    }

    func testProfileRoundTripNeutral() throws {
        var m = AdjustmentModel()
        m.profile = .neutral
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"papp:Profile="Neutral""#),
                      "non-default Profile must be emitted to the sidecar")
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.profile, .neutral)
    }

    /// `.auto` is the canonical default — serializer omits the attribute.
    func testProfileRoundTripAutoOmitted() throws {
        var m = AdjustmentModel()
        m.profile = .auto
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertFalse(xml.contains("papp:Profile"),
                       "Default Profile (.auto) should be omitted from sidecar")
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.profile, .auto)
    }

    /// Legacy migration: `papp:Look="Neutral"` with no `papp:Profile`
    /// seeds `profile = .neutral`. Mirrors raw-core's #536 migration.
    func testLegacyLookNeutralMigratesToProfileNeutral() throws {
        let xml = xmp(attrs: #"papp:Look="Neutral""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.profile, .neutral)
    }

    /// Legacy migration: `papp:Look="Default"` (pre-#536 sidecars carry
    /// this; `.default` was the historical default) seeds `.auto`.
    func testLegacyLookDefaultMigratesToProfileAuto() throws {
        let xml = xmp(attrs: #"papp:Look="Default""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.profile, .auto)
    }

    /// When both attributes are present, `papp:Profile` wins. Swift's
    /// attribute-dict iteration order is undefined, so the parser's
    /// pre-pass for `papp:Profile` (mirroring `sigma_seen`) is the
    /// load-bearing piece this test guards.
    func testProfileWinsOverLegacyLook() throws {
        let xml = xmp(attrs: #"papp:Profile="Neutral" papp:Look="Default""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.profile, .neutral)
    }

    /// Reverse attribute order — Profile still wins (order-independence
    /// is the whole point of the pre-pass).
    func testProfileWinsOverLegacyLookReverseOrder() throws {
        let xml = xmp(attrs: #"papp:Look="Default" papp:Profile="Neutral""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.profile, .neutral)
    }

    func testParseStars() throws {
        let xml = xmp(attrs: #"xmp:Rating="4""#)
        let (_, c) = try XMPParser.parse(xml)
        XCTAssertEqual(c.stars, 4)
    }

    func testUnknownAttributesIgnored() throws {
        let xml = xmp(attrs: #"crs:Exposure2012="2.0" crs:FutureThing="99""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.exposure, 2.0, accuracy: 0.01)
    }

    // MARK: - Serializer round-trip

    func testRoundTrip() throws {
        var m = AdjustmentModel()
        m.exposure = 1.5
        m.vibrance = 50
        m.highlights = -80
        m.highlightRecovery = .luminance
        let c = CullingState(stars: 3, flag: .pick)
        let xml = XMPSerializer.serialize(model: m, culling: c)
        let (m2, c2) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.exposure, m.exposure, accuracy: 0.01)
        XCTAssertEqual(m2.vibrance, m.vibrance, accuracy: 0.1)
        XCTAssertEqual(m2.highlights, m.highlights, accuracy: 0.1)
        XCTAssertEqual(m2.highlightRecovery, .luminance)
        XCTAssertEqual(c2.stars, 3)
        XCTAssertEqual(c2.flag, .pick)
    }


    // MARK: - XMPSidecarStore

    func testSidecarStoreWriteAndRead() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        defer {
            let xmpURL = tmp.deletingPathExtension().appendingPathExtension("xmp")
            try? FileManager.default.removeItem(at: xmpURL)
        }

        let store = XMPSidecarStore(rawURL: tmp)
        var m = AdjustmentModel()
        m.exposure = 0.75
        await store.update(model: m, culling: CullingState(stars: 2, flag: .none))
        await store.flush()

        // Read back
        let (m2, c2) = try await store.load()
        // Because we cached, this should return the in-memory state.
        XCTAssertEqual(m2.exposure, 0.75, accuracy: 0.01)
        XCTAssertEqual(c2.stars, 2)
    }


    // MARK: - Helpers

    // MARK: - Crop / straighten (ticket #277)

    func testDefaultCropIsIdentity() {
        let m = AdjustmentModel.default
        XCTAssertTrue(m.crop.isIdentity)
        XCTAssertEqual(m.crop.top, 0)
        XCTAssertEqual(m.crop.left, 0)
        XCTAssertEqual(m.crop.bottom, 1)
        XCTAssertEqual(m.crop.right, 1)
        XCTAssertEqual(m.crop.angle, 0)
    }

    func testParseCropWithHasCropTrue() throws {
        let xml = xmp(attrs:
            #"crs:HasCrop="True" crs:CropTop="0.1" crs:CropLeft="0.2" crs:CropBottom="0.9" crs:CropRight="0.8""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.crop.top, 0.1, accuracy: 1e-6)
        XCTAssertEqual(m.crop.left, 0.2, accuracy: 1e-6)
        XCTAssertEqual(m.crop.bottom, 0.9, accuracy: 1e-6)
        XCTAssertEqual(m.crop.right, 0.8, accuracy: 1e-6)
    }

    func testParseCropWithoutHasCropLeavesIdentity() throws {
        let xml = xmp(attrs: #"crs:CropTop="0.5" crs:CropBottom="0.9" crs:CropRight="0.9""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertTrue(m.crop.isIdentity, "crop without HasCrop must stay identity")
    }

    func testParseCropAngleAloneAppliesPureStraighten() throws {
        let xml = xmp(attrs: #"crs:CropAngle="-2.5""#)
        let (m, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m.crop.angle, -2.5, accuracy: 1e-6)
        XCTAssertEqual(m.crop.top, 0)
        XCTAssertEqual(m.crop.right, 1)
        XCTAssertFalse(m.crop.isIdentity)
    }

    func testCropRoundTrip() throws {
        var m = AdjustmentModel()
        m.crop = Crop(top: 0.05, left: 0.1, bottom: 0.95, right: 0.9, angle: 1.5)
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.crop.top, m.crop.top, accuracy: 1e-5)
        XCTAssertEqual(m2.crop.left, m.crop.left, accuracy: 1e-5)
        XCTAssertEqual(m2.crop.bottom, m.crop.bottom, accuracy: 1e-5)
        XCTAssertEqual(m2.crop.right, m.crop.right, accuracy: 1e-5)
        XCTAssertEqual(m2.crop.angle, m.crop.angle, accuracy: 1e-5)
    }

    func testIdentityCropOmitsCropGroupOnSerialize() throws {
        let xml = XMPSerializer.serialize(
            model: AdjustmentModel(), culling: CullingState()
        )
        XCTAssertFalse(xml.contains("crs:HasCrop"),
                       "identity crop must not emit crs:HasCrop")
        XCTAssertFalse(xml.contains("crs:CropTop"),
                       "identity crop must not emit crs:CropTop")
        XCTAssertFalse(xml.contains("crs:CropAngle"),
                       "identity crop must not emit crs:CropAngle")
    }

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
