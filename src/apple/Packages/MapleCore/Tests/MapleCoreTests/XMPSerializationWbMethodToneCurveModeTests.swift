// XMPSerializationWbMethodToneCurveModeTests.swift — #2216 companion to
// XMPSerializationTests.swift (split out to stay under the 600-line hard
// budget, CONTRIBUTING.md § "File-size budget" — same rationale as
// XMPSerializationAutoExposureTests.swift).
//
// Covers `papp:WbMethod` (#431) and `papp:ToneCurveMode` (#436), mirrored
// into the Swift `AdjustmentModel` by #2216 — before this ticket the Swift
// reader/writer deliberately left both unwired (`GpuLiveParams.swift`'s
// header said so in so many words), so a sidecar written by web/API lost
// them on an Apple round trip. See `AdjustmentModel.WbMethod` /
// `.ToneCurveMode` and `XMPSerialization+Attrs.swift` for the write side,
// `XMPSerialization+ParseAttrs.swift` for the parse side. Wire values must
// match `raw-core`'s (`xmp/fields.rs`) and the TS writer's
// (`xmp-serializer.service.ts`) exactly — see `enum-modes.spec.ts`'s
// `papp:WbMethod` / `papp:ToneCurveMode` sections, which this file mirrors.

import XCTest
@testable import MapleCore

final class XMPSerializationWbMethodToneCurveModeTests: XCTestCase {

    // MARK: - papp:WbMethod

    /// `papp:WbMethod` parses case-insensitively onto the model — mirrors
    /// raw-core's own `"cat16" | "Cat16" | "CAT16"` / `"diagonalrec2020" |
    /// "DiagonalRec2020"` match (`xmp/fields.rs`). Unknown values keep the
    /// default rather than erroring the whole sidecar (Apple parser
    /// convention — mirrors every other `papp:` enum in this file family).
    func testParseWbMethod() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: #"papp:WbMethod="DiagonalRec2020""#))
        XCTAssertEqual(m.wbMethod, .diagonalRec2020)
        let (m2, _) = try XMPParser.parse(xmp(attrs: #"papp:WbMethod="CAT16""#))
        XCTAssertEqual(m2.wbMethod, .cat16)
        let (m3, _) = try XMPParser.parse(xmp(attrs: #"papp:WbMethod="Bradford""#))
        XCTAssertEqual(m3.wbMethod, .cat16, "unknown value keeps the default")
    }

    /// A sidecar predating #431 (no `papp:WbMethod` at all) parses to the
    /// default `.cat16` — matches raw-core's own parse default so a sidecar
    /// written before this field existed doesn't silently change render
    /// behavior on next open.
    func testParseWbMethodAbsentDefaultsToCat16() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: #"crs:Exposure2012="1.0""#))
        XCTAssertEqual(m.wbMethod, .cat16)
    }

    /// Round-trips through serialize → parse; the default (`.cat16`) emits
    /// no attribute so sidecars predating this field stay byte-identical.
    func testWbMethodRoundTripAndDefaultOmission() throws {
        var m = AdjustmentModel()
        m.wbMethod = .diagonalRec2020
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"papp:WbMethod="DiagonalRec2020""#))
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.wbMethod, .diagonalRec2020)

        let defaultXml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(defaultXml.contains("papp:WbMethod"),
                       "default .cat16 must not be serialized")
    }

    // MARK: - papp:ToneCurveMode

    /// `papp:ToneCurveMode` parses case-insensitively onto the model —
    /// mirrors raw-core's `"perchannel" | "PerChannel"` / `"ratiopreserving"
    /// | "RatioPreserving"` match. Unknown values keep the default.
    func testParseToneCurveMode() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: #"papp:ToneCurveMode="RatioPreserving""#))
        XCTAssertEqual(m.toneCurveMode, .ratioPreserving)
        let (m2, _) = try XMPParser.parse(xmp(attrs: #"papp:ToneCurveMode="perchannel""#))
        XCTAssertEqual(m2.toneCurveMode, .perChannel)
        let (m3, _) = try XMPParser.parse(xmp(attrs: #"papp:ToneCurveMode="Filmic""#))
        XCTAssertEqual(m3.toneCurveMode, .perChannel, "unknown value keeps the default")
    }

    /// A sidecar predating #436 (no `papp:ToneCurveMode` at all) parses to
    /// the default `.perChannel`.
    func testParseToneCurveModeAbsentDefaultsToPerChannel() throws {
        let (m, _) = try XMPParser.parse(xmp(attrs: #"crs:Exposure2012="1.0""#))
        XCTAssertEqual(m.toneCurveMode, .perChannel)
    }

    /// Round-trips through serialize → parse; the default (`.perChannel`)
    /// emits no attribute so sidecars predating this field stay
    /// byte-identical.
    func testToneCurveModeRoundTripAndDefaultOmission() throws {
        var m = AdjustmentModel()
        m.toneCurveMode = .ratioPreserving
        let xml = XMPSerializer.serialize(model: m, culling: CullingState())
        XCTAssertTrue(xml.contains(#"papp:ToneCurveMode="RatioPreserving""#))
        let (m2, _) = try XMPParser.parse(xml)
        XCTAssertEqual(m2.toneCurveMode, .ratioPreserving)

        let defaultXml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
        XCTAssertFalse(defaultXml.contains("papp:ToneCurveMode"),
                       "default .perChannel must not be serialized")
    }

    // MARK: - Passthrough interaction

    /// Before #2216 these two attributes survived an Apple save only through
    /// the general unknown-attribute passthrough bucket (#2233) — never
    /// applied to the model, so the GPU-live chain silently ignored them.
    /// Now that they parse into the model AND serialize from it, they must
    /// be claimed as KNOWN attributes (`XMPKnownFields`) — otherwise a
    /// load → save cycle would emit each one twice: once from the model,
    /// once verbatim from passthrough. Mirrors the TS parity test in
    /// `enum-modes.spec.ts`.
    func testWbMethodAndToneCurveModeAreClaimedNotDoubleEmitted() throws {
        let source = xmp(attrs: [
            #"papp:AutoExposure="Off""#,
            #"papp:HighlightRecoveryMode="Blend""#,
            #"papp:WbMethod="DiagonalRec2020""#,
            #"papp:ToneCurveMode="RatioPreserving""#,
        ].joined(separator: "\n      "))

        let passthrough = XMPParser.parsePassthrough(source)
        XCTAssertTrue(passthrough.unknownAttributes.isEmpty,
                      "known papp: enum attributes must not land in the passthrough bucket")

        let (model, _) = try XMPParser.parse(source)
        let resaved = XMPSerializer.serialize(model: model, culling: CullingState(), passthrough: passthrough)
        for attr in ["papp:AutoExposure", "papp:HighlightRecoveryMode",
                     "papp:WbMethod", "papp:ToneCurveMode"] {
            let count = resaved.components(separatedBy: "\(attr)=").count - 1
            XCTAssertEqual(count, 1, "\(attr) must appear exactly once")
        }
    }

    // MARK: - Real on-disk sidecar round trip

    /// `XMPSidecarStore` write → read carries both fields across the REAL
    /// on-disk `.xmp` boundary (no mocks — CLAUDE.md § "No mocks for the
    /// sidecar layer"), mirroring
    /// `XMPSerializationAutoExposureTests.testSidecarStoreRoundTripAutoExposure`.
    /// Regression coverage for #2216: before this ticket neither field
    /// existed on the Swift model, so a web-authored sidecar carrying a
    /// non-default `wbMethod`/`toneCurveMode` would silently lose it on the
    /// next Apple save (latent data loss).
    func testSidecarStoreRoundTripWbMethodAndToneCurveMode() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        defer {
            let xmpURL = tmp.deletingPathExtension().appendingPathExtension("xmp")
            try? FileManager.default.removeItem(at: xmpURL)
        }

        var m = AdjustmentModel()
        m.wbMethod = .diagonalRec2020
        m.toneCurveMode = .ratioPreserving

        let store = XMPSidecarStore(rawURL: tmp)
        await store.update(model: m, culling: CullingState())
        await store.flush()

        // Drop the in-memory cache so the read actually goes to disk.
        let fresh = XMPSidecarStore(rawURL: tmp)
        let (m2, _) = try await fresh.load()
        XCTAssertEqual(m2.wbMethod, .diagonalRec2020)
        XCTAssertEqual(m2.toneCurveMode, .ratioPreserving)
    }

    // MARK: - GPU-live param mapping (the render-side half of the fix)

    /// Wiring the model fields alone would leave the sidecar byte-parity
    /// story fixed but the GPU-live canvas still silently rendering CAT16 /
    /// PerChannel — `GpuLiveParams.swift`'s `makeGpuLiveParams` must map a
    /// non-default model value onto the FFI's `wb_method`/`tone_curve_mode`
    /// scalars (`1` = DiagonalRec2020 / RatioPreserving, per
    /// `MapleGpuLiveParams`'s header doc).
    func testGpuLiveParamsMapsWbMethodAndToneCurveMode() {
        var m = AdjustmentModel()
        m.wbMethod = .diagonalRec2020
        m.toneCurveMode = .ratioPreserving
        let p = PipelineRenderer.makeGpuLiveParams(from: m)
        XCTAssertEqual(p.wb_method, 1)
        XCTAssertEqual(p.tone_curve_mode, 1)

        let defaultParams = PipelineRenderer.makeGpuLiveParams(from: AdjustmentModel())
        XCTAssertEqual(defaultParams.wb_method, 0)
        XCTAssertEqual(defaultParams.tone_curve_mode, 0)
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
