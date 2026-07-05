// XMPSerializationTests.swift — XMP serializer/parser round-trip tests for the
// `dc:subject` keyword bag (#632) and the S5 effects attributes (vignette /
// grain / split-tone, #643). Split out of `AdjustmentModelTests` to keep both
// files under the 600-line budget (CONTRIBUTING.md). Model defaults and the
// basic `crs:` parse tests stay in `AdjustmentModelTests`; this file owns the
// keyword + S5 wire-format coverage that mirrors `XMPSerialization.swift`.

import XCTest
@testable import MapleCore

final class XMPSerializationTests: XCTestCase {

    // MARK: - Keywords (dc:subject) round-trip — #632

    /// Default `CullingState` carries an empty keyword list — matches the
    /// "no `dc:subject` element on the wire" sidecar default.
    func testDefaultKeywordsIsEmpty() {
        XCTAssertEqual(CullingState().keywords, [])
    }

    /// Empty list omits the `<dc:subject>` element entirely so the
    /// round-trip empty → no element → empty matches the default.
    func testSerializerOmitsEmptyKeywordsBlock() {
        let xml = XMPSerializer.serialize(model: .default, culling: CullingState())
        XCTAssertFalse(xml.contains("dc:subject"),
                       "Empty keyword list should not emit a dc:subject element")
        XCTAssertFalse(xml.contains("xmlns:dc="),
                       "Empty keyword list should not declare the dc: namespace")
    }

    /// Non-empty list emits `<dc:subject><rdf:Bag><rdf:li>…</rdf:Bag></dc:subject>`
    /// and the parser pulls every `rdf:li` back out in source order.
    func testKeywordsRoundTrip() throws {
        let c = CullingState(
            stars: 3,
            flag: .pick,
            keywords: ["travel", "paris", "2026", "golden hour"]
        )
        let xml = XMPSerializer.serialize(model: .default, culling: c)
        XCTAssertTrue(xml.contains("<dc:subject>"))
        XCTAssertTrue(xml.contains("<rdf:Bag>"))
        XCTAssertTrue(xml.contains("<rdf:li>travel</rdf:li>"))
        XCTAssertTrue(xml.contains("<rdf:li>golden hour</rdf:li>"))
        XCTAssertTrue(xml.contains(#"xmlns:dc="http://purl.org/dc/elements/1.1/""#))

        let (_, c2) = try XMPParser.parse(xml)
        XCTAssertEqual(c2.keywords, ["travel", "paris", "2026", "golden hour"])
        XCTAssertEqual(c2.stars, 3)
        XCTAssertEqual(c2.flag, .pick)
    }

    /// Single-keyword case — easy to regress to an empty `Bag`.
    func testSingleKeywordRoundTrip() throws {
        let c = CullingState(keywords: ["solo"])
        let xml = XMPSerializer.serialize(model: .default, culling: c)
        let (_, c2) = try XMPParser.parse(xml)
        XCTAssertEqual(c2.keywords, ["solo"])
    }

    /// XML-special characters in keyword text must be escaped on the
    /// write path and re-decoded on the read path.
    func testKeywordsEscapeXMLSpecials() throws {
        let c = CullingState(keywords: ["fish & chips", "<tag>", "5 > 3"])
        let xml = XMPSerializer.serialize(model: .default, culling: c)
        XCTAssertTrue(xml.contains("fish &amp; chips"))
        XCTAssertTrue(xml.contains("&lt;tag&gt;"))
        let (_, c2) = try XMPParser.parse(xml)
        XCTAssertEqual(c2.keywords, ["fish & chips", "<tag>", "5 > 3"])
    }

    /// A sidecar that doesn't carry `dc:subject` at all parses with the
    /// default empty keyword list (no false-positive injection).
    func testParseSidecarWithoutDcSubject() throws {
        let xml = xmp(attrs: #"crs:Exposure2012="1.0""#)
        let (_, c) = try XMPParser.parse(xml)
        XCTAssertEqual(c.keywords, [])
    }

    /// Whitespace-only keywords are dropped on the read path — `dc:subject`
    /// rejects blank `rdf:li` entries.
    func testParseKeywordsDropsBlankLi() throws {
        let xml = """
        <?xml version="1.0"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description
              xmlns:dc="http://purl.org/dc/elements/1.1/">
              <dc:subject>
                <rdf:Bag>
                  <rdf:li>real</rdf:li>
                  <rdf:li>   </rdf:li>
                  <rdf:li></rdf:li>
                  <rdf:li>also real</rdf:li>
                </rdf:Bag>
              </dc:subject>
            </rdf:Description>
          </rdf:RDF>
        </x:xmpmeta>
        """
        let (_, c) = try XMPParser.parse(xml)
        XCTAssertEqual(c.keywords, ["real", "also real"])
    }

    /// Legacy JSON blobs encoded before #632 (no `keywords` field) still
    /// decode — the custom `init(from:)` defaults the missing key to `[]`
    /// rather than throwing `.keyNotFound`. Guards against breakage of any
    /// cache layer that persists `CullingState` via Codable.
    func testCullingStateCodableDecodesLegacyJSONWithoutKeywordsKey() throws {
        let legacy = #"{"stars":3,"flag":"pick"}"#
        let decoded = try JSONDecoder().decode(CullingState.self, from: Data(legacy.utf8))
        XCTAssertEqual(decoded.stars, 3)
        XCTAssertEqual(decoded.flag, .pick)
        XCTAssertEqual(decoded.keywords, [])
    }

    /// Round-trip through JSONEncoder/JSONDecoder preserves keywords.
    func testCullingStateCodableRoundTrip() throws {
        let original = CullingState(stars: 4, flag: .pick, keywords: ["a", "b", "c"])
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(CullingState.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    /// `XMPSidecarStore` write → read carries the keyword list across
    /// the on-disk boundary.
    func testSidecarStoreRoundTripKeywords() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        defer {
            let xmpURL = tmp.deletingPathExtension().appendingPathExtension("xmp")
            try? FileManager.default.removeItem(at: xmpURL)
        }

        let store = XMPSidecarStore(rawURL: tmp)
        await store.update(
            model: .default,
            culling: CullingState(stars: 1, keywords: ["a", "b", "c"])
        )
        await store.flush()

        // Drop the in-memory cache so the read actually goes to disk.
        let fresh = XMPSidecarStore(rawURL: tmp)
        let (_, c2) = try await fresh.load()
        XCTAssertEqual(c2.keywords, ["a", "b", "c"])
        XCTAssertEqual(c2.stars, 1)
    }

    /// `papp:Hidden` is tri-state: an untouched `CullingState` (`hidden ==
    /// nil`) must emit no attribute at all, never a default `"false"` —
    /// the backend treats any written value, including "false", as an
    /// explicit override that would silently un-hide an asset hidden by
    /// other means (AI verdict, a prior manual hide from elsewhere).
    /// Regression test for the PR #1782 follow-up review finding.
    func testHiddenTriStateRoundTripAndDefaultOmission() throws {
        let untouchedXml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(
            untouchedXml.contains("papp:Hidden"),
            "an untouched CullingState must never write papp:Hidden"
        )
        let (_, untouchedCulling) = try XMPParser.parse(untouchedXml)
        XCTAssertNil(untouchedCulling.hidden, "absent papp:Hidden must parse back to nil")

        let hiddenXml = XMPSerializer.serialize(
            model: AdjustmentModel(), culling: CullingState(hidden: true))
        XCTAssertTrue(hiddenXml.contains(#"papp:Hidden="true""#))
        let (_, hiddenCulling) = try XMPParser.parse(hiddenXml)
        XCTAssertEqual(hiddenCulling.hidden, true)

        let unhiddenXml = XMPSerializer.serialize(
            model: AdjustmentModel(), culling: CullingState(hidden: false))
        XCTAssertTrue(unhiddenXml.contains(#"papp:Hidden="false""#))
        let (_, unhiddenCulling) = try XMPParser.parse(unhiddenXml)
        XCTAssertEqual(unhiddenCulling.hidden, false)
    }

    // MARK: - S5 effects fields (#643)

    /// Parses Lightroom-compatible `crs:` keys for vignette / grain /
    /// split-tone into the new model fields.
    func testParseS5EffectsFields() throws {
        let attrs = #"""
        crs:PostCropVignetteAmount="-40"
        crs:PostCropVignetteFeather="70"
        crs:GrainAmount="35"
        crs:GrainSize="40"
        crs:GrainFrequency="55"
        crs:SplitToningShadowHue="220"
        crs:SplitToningShadowSaturation="30"
        crs:SplitToningHighlightHue="40"
        crs:SplitToningHighlightSaturation="25"
        crs:SplitToningBalance="-15"
        """#
        let (m, _) = try XMPParser.parse(xmp(attrs: attrs))
        XCTAssertEqual(m.vignetteAmount, -40)
        XCTAssertEqual(m.vignetteFeather, 70)
        XCTAssertEqual(m.grainAmount, 35)
        XCTAssertEqual(m.grainSize, 40)
        XCTAssertEqual(m.grainRoughness, 55)
        XCTAssertEqual(m.splitToneShadowHue, 220)
        XCTAssertEqual(m.splitToneShadowSaturation, 30)
        XCTAssertEqual(m.splitToneHighlightHue, 40)
        XCTAssertEqual(m.splitToneHighlightSaturation, 25)
        XCTAssertEqual(m.splitToneBalance, -15)
    }

    /// S5 effects fields round-trip through serialize → parse, and
    /// non-default values emit `crs:` keys. Pre-existing default-shaped
    /// sidecars stay byte-identical because the serializer only emits
    /// non-default values (guarded by `testS5EffectsDefaultsNotSerialized`
    /// below).
    func testS5EffectsRoundTrip() throws {
        var m = AdjustmentModel()
        m.vignetteAmount = -35
        m.vignetteFeather = 80
        m.grainAmount = 25
        m.grainSize = 40
        m.grainRoughness = 60
        m.splitToneShadowHue = 200
        m.splitToneShadowSaturation = 20
        m.splitToneHighlightHue = 45
        m.splitToneHighlightSaturation = 15
        m.splitToneBalance = -10
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"crs:PostCropVignetteAmount="-35""#))
        XCTAssertTrue(xml.contains(#"crs:GrainFrequency="60""#))
        XCTAssertTrue(xml.contains(#"crs:SplitToningBalance="-10""#))
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.vignetteAmount, -35)
        XCTAssertEqual(m2.vignetteFeather, 80)
        XCTAssertEqual(m2.grainAmount, 25)
        XCTAssertEqual(m2.grainSize, 40)
        XCTAssertEqual(m2.grainRoughness, 60)
        XCTAssertEqual(m2.splitToneShadowHue, 200)
        XCTAssertEqual(m2.splitToneShadowSaturation, 20)
        XCTAssertEqual(m2.splitToneHighlightHue, 45)
        XCTAssertEqual(m2.splitToneHighlightSaturation, 15)
        XCTAssertEqual(m2.splitToneBalance, -10)
    }

    /// Default-valued S5 effects fields MUST NOT emit any `crs:` keys, so
    /// sidecars produced before #643 remain byte-identical for users who
    /// never touch the new tools.
    func testS5EffectsDefaultsNotSerialized() {
        let xml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(xml.contains("crs:PostCropVignetteAmount"))
        XCTAssertFalse(xml.contains("crs:PostCropVignetteFeather"))
        XCTAssertFalse(xml.contains("crs:GrainAmount"))
        XCTAssertFalse(xml.contains("crs:GrainSize"))
        XCTAssertFalse(xml.contains("crs:GrainFrequency"))
        XCTAssertFalse(xml.contains("crs:SplitToningShadowHue"))
        XCTAssertFalse(xml.contains("crs:SplitToningShadowSaturation"))
        XCTAssertFalse(xml.contains("crs:SplitToningHighlightHue"))
        XCTAssertFalse(xml.contains("crs:SplitToningHighlightSaturation"))
        XCTAssertFalse(xml.contains("crs:SplitToningBalance"))
    }

    // MARK: - Brightness (#1102)

    /// `papp:Brightness` parses onto `model.brightness`; the legacy ACR
    /// PV2010 `crs:Brightness` key is deliberately NOT parsed (different
    /// semantics — default +50, removed in PV2012).
    func testParseBrightness() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: #"papp:Brightness="-35""#))
        XCTAssertEqual(m.brightness, -35)

        let (m2, _) = try XMPParser.parse(xmp(attrs: #"crs:Brightness="50""#))
        XCTAssertEqual(m2.brightness, 0, "crs:Brightness (PV2010) must not map onto brightness")
    }

    /// Brightness round-trips through serialize → parse on a real sidecar
    /// string, and the default (0) emits no attribute so pre-#1102
    /// sidecars stay byte-identical.
    func testBrightnessRoundTripAndDefaultOmission() throws {
        var m = AdjustmentModel()
        m.brightness = 42
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"papp:Brightness="42""#))
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.brightness, 42)

        let defaultXml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(defaultXml.contains("papp:Brightness"),
                       "default brightness must not be serialized")
    }

    // MARK: - Chroma pre-filter (#1104)

    /// `papp:ChromaPrefilter` parses onto `model.chromaPrefilter`, and it
    /// is distinct from ACR's `crs:ColorNoiseReduction` (which maps onto
    /// the late-chain `nrColor` NLM slider).
    func testParseChromaPrefilter() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: #"papp:ChromaPrefilter="35""#))
        XCTAssertEqual(m.chromaPrefilter, 35)
        XCTAssertEqual(m.nrColor, 25, "nrColor must stay at its default")
    }

    /// ChromaPrefilter round-trips through serialize → parse, and the
    /// default (0) emits no attribute so pre-#1104 sidecars stay
    /// byte-identical.
    func testChromaPrefilterRoundTripAndDefaultOmission() throws {
        var m = AdjustmentModel()
        m.chromaPrefilter = 35
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"papp:ChromaPrefilter="35""#))
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.chromaPrefilter, 35)

        let defaultXml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(defaultXml.contains("papp:ChromaPrefilter"),
                       "default chromaPrefilter must not be serialized")
    }

    /// The decode-baked field must survive `stripAppleGPUStages` — the
    /// strip removes only the stages the per-tick Apple chain re-applies,
    /// and the chroma pre-filter has no chain equivalent. This is also
    /// what keys the decoded-image cache (#950 baked model): if the strip
    /// dropped it, edits to the field would silently never re-decode.
    func testStripKeepsChromaPrefilter() {
        var m = AdjustmentModel()
        m.chromaPrefilter = 60
        let stripped = RawCoreBridge.stripAppleGPUStages(m)
        XCTAssertEqual(stripped.chromaPrefilter, 60,
                       "stripAppleGPUStages must keep the decode-baked chromaPrefilter")
    }

    // MARK: - Hot/dead-pixel suppression (#1106)

    /// `papp:HotPixelSuppression` parses case-insensitively onto the
    /// model; unknown values keep the default rather than erroring the
    /// whole sidecar (Apple parser convention).
    func testParseHotPixelSuppression() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: #"papp:HotPixelSuppression="On""#))
        XCTAssertEqual(m.hotPixelSuppression, .on)
        let (m2, _) = try XMPParser.parse(xmp(attrs: #"papp:HotPixelSuppression="off""#))
        XCTAssertEqual(m2.hotPixelSuppression, .off)
        let (m3, _) = try XMPParser.parse(xmp(attrs: #"papp:HotPixelSuppression="Maybe""#))
        XCTAssertEqual(m3.hotPixelSuppression, .off, "unknown value keeps the default")
    }

    /// HotPixelSuppression round-trips through serialize → parse, and the
    /// default (.off) emits no attribute so pre-#1106 sidecars stay
    /// byte-identical.
    func testHotPixelSuppressionRoundTripAndDefaultOmission() throws {
        var m = AdjustmentModel()
        m.hotPixelSuppression = .on
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"papp:HotPixelSuppression="On""#))
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.hotPixelSuppression, .on)

        let defaultXml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(defaultXml.contains("papp:HotPixelSuppression"),
                       "default .off must not be serialized")
    }

    /// The decode-baked field must survive `stripAppleGPUStages` — same
    /// cache-key contract as `chromaPrefilter` (#950 baked model).
    func testStripKeepsHotPixelSuppression() {
        var m = AdjustmentModel()
        m.hotPixelSuppression = .on
        let stripped = RawCoreBridge.stripAppleGPUStages(m)
        XCTAssertEqual(stripped.hotPixelSuppression, .on,
                       "stripAppleGPUStages must keep the decode-baked hotPixelSuppression")
    }

    // MARK: - BM3D deep denoise (#1105)

    /// `papp:DeepDenoise` parses, round-trips, and is omitted at the
    /// default (0) so pre-#1105 sidecars stay byte-identical; the
    /// decode-baked field survives `stripAppleGPUStages` (the #950
    /// baked-model cache-key contract — this is what makes the BM3D run
    /// a one-time cost per setting).
    func testDeepDenoiseRoundTripDefaultOmissionAndStrip() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: #"papp:DeepDenoise="70""#))
        XCTAssertEqual(m.deepDenoise, 70)

        var m2 = AdjustmentModel()
        m2.deepDenoise = 70
        let xml = XMPSerializer.serialize(model: m2, culling: CullingState())
        XCTAssertTrue(xml.contains(#"papp:DeepDenoise="70""#))
        let (m3, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m3.deepDenoise, 70)

        let defaultXml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(defaultXml.contains("papp:DeepDenoise"),
                       "default deepDenoise must not be serialized")

        let stripped = RawCoreBridge.stripAppleGPUStages(m2)
        XCTAssertEqual(stripped.deepDenoise, 70,
                       "stripAppleGPUStages must keep the decode-baked deepDenoise")
    }

    // MARK: - S5 effects + keywords interaction (#632 / #643 merge)

    /// The reconciliation of the two XMP file-splits introduces one case
    /// neither `testS5EffectsRoundTrip` (empty culling) nor
    /// `testKeywordsRoundTrip` (default model) exercises: S5 effect
    /// attributes living inside the open/close `rdf:Description` form
    /// *alongside* the `dc:subject` keyword bag. Setting both in one
    /// sidecar proves the S5 attrs were appended to the shared `attrs`
    /// list (so they survive the keyword-bearing output branch) and that
    /// the keyword sub-parser still recovers the bag when S5 attributes
    /// precede it.
    func testS5EffectsAndKeywordsRoundTripTogether() throws {
        var m = AdjustmentModel()
        m.vignetteAmount = -35
        m.grainAmount = 25
        m.splitToneShadowHue = 200
        m.splitToneBalance = -10
        let c = CullingState(stars: 3, flag: .pick, keywords: ["travel", "paris", "2026"])

        let xml = XMPSerializer.serialize(model: m, culling: c)
        // S5 attrs must appear in the keyword-bearing (open/close) form.
        XCTAssertTrue(xml.contains(#"crs:PostCropVignetteAmount="-35""#))
        XCTAssertTrue(xml.contains(#"crs:SplitToningBalance="-10""#))
        XCTAssertTrue(xml.contains("<dc:subject>"))

        let (m2, c2) = try XMPParser.parse(xml)
        // S5 fields survive.
        XCTAssertEqual(m2.vignetteAmount, -35)
        XCTAssertEqual(m2.grainAmount, 25)
        XCTAssertEqual(m2.splitToneShadowHue, 200)
        XCTAssertEqual(m2.splitToneBalance, -10)
        // Keywords + culling survive.
        XCTAssertEqual(c2.keywords, ["travel", "paris", "2026"])
        XCTAssertEqual(c2.stars, 3)
        XCTAssertEqual(c2.flag, .pick)
    }

    // MARK: - serializeMetadataOnly (#1638)

    func testSerializeMetadataOnlyHasNoCrsAttributes() {
        var meta = XmpMetadata()
        meta.city = "Paris"
        meta.copyrightNotice = "© 2026"
        let xml = XMPSerializer.serializeMetadataOnly(metadata: meta)
        XCTAssertFalse(xml.contains("crs:"), "metadata-only XMP must not contain crs: attributes")
        XCTAssertTrue(xml.contains("Paris"), "metadata-only XMP must include city value")
    }

    func testSerializeMetadataOnlyRoundTrips() {
        var meta = XmpMetadata()
        meta.city = "Berlin"
        meta.gpsLatitude = 52.5200
        meta.gpsLongitude = 13.4050
        let xml = XMPSerializer.serializeMetadataOnly(metadata: meta)
        let parsed = XMPParser.parseMetadata(xml)
        XCTAssertEqual(parsed.city, "Berlin")
        XCTAssertNotNil(parsed.gpsLatitude)
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
