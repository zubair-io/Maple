// SceneLinearChainCacheTests.swift — unit coverage for #661's single-entry
// LRU cache around `applySceneLinearChainViaFFI`.
//
// Two layers:
//
//   1. Key construction — verifies the hash excludes the post-FFI
//      sliders (sharpen* / nrColor / captureSharpening*) and includes
//      every scene-linear input. This is the correctness invariant the
//      decision comment on #661 calls out: missing an input means the
//      user sees stale pixels; including a post-FFI slider just wastes
//      hits (safe but pointless).
//
//   2. LRU surface — get / put / single-slot eviction / disable env
//      hook. The cache is a tiny in-memory data structure; these tests
//      don't go through the full pipeline (no fixtures required) so
//      they run as part of the default `swift test` inner loop.

import Foundation
import XCTest
import CoreImage
@testable import MapleCore

final class SceneLinearChainCacheTests: XCTestCase {

    // MARK: - Key construction

    /// Two structurally identical (assetID, model, FFI params, extent)
    /// inputs must produce equal keys. Equality is the contract on
    /// which every cache hit depends.
    func testKeyEqualityForIdenticalInputs() {
        let id = UUID()
        let model = AdjustmentModel.default
        let a = SceneLinearChainCache.make(
            assetID: id, model: model,
            decodedTemperature: 6500, decodedTint: 0,
            skipAgX: false, width: 1920, height: 1080
        )
        let b = SceneLinearChainCache.make(
            assetID: id, model: AdjustmentModel.default,
            decodedTemperature: 6500, decodedTint: 0,
            skipAgX: false, width: 1920, height: 1080
        )
        XCTAssertEqual(a, b)
    }

    /// Each of the 21 scene-linear fields must change the key when
    /// mutated — the cache MUST invalidate on every input that
    /// influences FFI output. This is the correctness gate the
    /// decision comment makes load-bearing.
    func testSceneLinearFieldsAreInKey() {
        let id = UUID()
        let base = SceneLinearChainCache.make(
            assetID: id, model: .default,
            decodedTemperature: 6500, decodedTint: 0,
            skipAgX: false, width: 1920, height: 1080
        )

        // Each closure mutates one scene-linear field of an
        // AdjustmentModel.default; the resulting key MUST differ from
        // the base. Floats use small non-zero values so we never
        // accidentally test a default-equal mutation.
        let mutations: [(String, (inout AdjustmentModel) -> Void)] = [
            ("temperature",          { $0.temperature = 5500 }),
            ("tint",                 { $0.tint = 10 }),
            ("exposure",             { $0.exposure = 0.5 }),
            ("contrast",             { $0.contrast = 10 }),
            ("highlights",           { $0.highlights = 10 }),
            ("shadows",              { $0.shadows = 10 }),
            ("whites",               { $0.whites = 10 }),
            ("blacks",               { $0.blacks = 10 }),
            ("parametricHighlights", { $0.parametricHighlights = 10 }),
            ("parametricLights",     { $0.parametricLights = 10 }),
            ("parametricDarks",      { $0.parametricDarks = 10 }),
            ("parametricShadows",    { $0.parametricShadows = 10 }),
            ("vibrance",             { $0.vibrance = 10 }),
            ("saturation",           { $0.saturation = 10 }),
            ("clarity",              { $0.clarity = 10 }),
            ("texture",              { $0.texture = 10 }),
            ("dehaze",               { $0.dehaze = 10 }),
            ("nrLuminance",          { $0.nrLuminance = 10 }),
        ]

        for (label, mutate) in mutations {
            var m = AdjustmentModel.default
            mutate(&m)
            let mutated = SceneLinearChainCache.make(
                assetID: id, model: m,
                decodedTemperature: 6500, decodedTint: 0,
                skipAgX: false, width: 1920, height: 1080
            )
            XCTAssertNotEqual(
                base, mutated,
                "key must differ when \(label) changes — otherwise the cache returns stale pixels"
            )
        }
    }

    /// #1916 regression gate. Every field the FFI chain grew into after
    /// #661's original 21-field list — brightness (#1102), the 24 HSL bands
    /// (#1112), vignette (#1109), split-tone (#1111), grain (#1110) — was
    /// silently absent from the digest, so dragging any of those sliders
    /// returned a stale cached image (the slider "did nothing"). Each must
    /// now invalidate the key.
    ///
    /// This drives the change through a REAL sidecar round-trip (serialize
    /// to a `.xmp` on disk → `XMPParser.parse` → build the key from the
    /// parsed model) rather than mutating an in-memory model, per the
    /// project contract that the sidecar layer is never mocked (CLAUDE.md:
    /// "XMP is the contract; mocks let bugs through"). It therefore also
    /// proves each field survives serialize/parse on its way to the key.
    ///
    /// Values are integers so the serializer's `%.0f` formatting round-trips
    /// exactly.
    func testPreviouslyOmittedFieldsInvalidateKeyThroughSidecarRoundTrip() throws {
        let id = UUID()
        let base = try keyThroughSidecarRoundTrip(.default, assetID: id)

        let mutations: [(String, (inout AdjustmentModel) -> Void)] = [
            // scene_tone_controls
            ("brightness", { $0.brightness = 40 }),
            // vignette (#1109)
            ("vignetteAmount", { $0.vignetteAmount = -30 }),
            ("vignetteFeather", { $0.vignetteFeather = 70 }),
            // grain (#1110) — post-AgX
            ("grainAmount", { $0.grainAmount = 50 }),
            ("grainSize", { $0.grainSize = 40 }),
            ("grainRoughness", { $0.grainRoughness = 80 }),
            // split-tone (#1111) — post-AgX
            ("splitToneShadowHue", { $0.splitToneShadowHue = 210 }),
            ("splitToneShadowSaturation", { $0.splitToneShadowSaturation = 40 }),
            ("splitToneHighlightHue", { $0.splitToneHighlightHue = 60 }),
            ("splitToneHighlightSaturation", { $0.splitToneHighlightSaturation = 30 }),
            ("splitToneBalance", { $0.splitToneBalance = 25 }),
            // hsl 8-band hue/sat/lum (#1112)
            ("hueAdjustmentRed", { $0.hueAdjustmentRed = 30 }),
            ("hueAdjustmentOrange", { $0.hueAdjustmentOrange = 30 }),
            ("hueAdjustmentYellow", { $0.hueAdjustmentYellow = 30 }),
            ("hueAdjustmentGreen", { $0.hueAdjustmentGreen = 30 }),
            ("hueAdjustmentAqua", { $0.hueAdjustmentAqua = 30 }),
            ("hueAdjustmentBlue", { $0.hueAdjustmentBlue = 30 }),
            ("hueAdjustmentPurple", { $0.hueAdjustmentPurple = 30 }),
            ("hueAdjustmentMagenta", { $0.hueAdjustmentMagenta = 30 }),
            ("saturationAdjustmentRed", { $0.saturationAdjustmentRed = 30 }),
            ("saturationAdjustmentOrange", { $0.saturationAdjustmentOrange = 30 }),
            ("saturationAdjustmentYellow", { $0.saturationAdjustmentYellow = 30 }),
            ("saturationAdjustmentGreen", { $0.saturationAdjustmentGreen = 30 }),
            ("saturationAdjustmentAqua", { $0.saturationAdjustmentAqua = 30 }),
            ("saturationAdjustmentBlue", { $0.saturationAdjustmentBlue = 30 }),
            ("saturationAdjustmentPurple", { $0.saturationAdjustmentPurple = 30 }),
            ("saturationAdjustmentMagenta", { $0.saturationAdjustmentMagenta = 30 }),
            ("luminanceAdjustmentRed", { $0.luminanceAdjustmentRed = 30 }),
            ("luminanceAdjustmentOrange", { $0.luminanceAdjustmentOrange = 30 }),
            ("luminanceAdjustmentYellow", { $0.luminanceAdjustmentYellow = 30 }),
            ("luminanceAdjustmentGreen", { $0.luminanceAdjustmentGreen = 30 }),
            ("luminanceAdjustmentAqua", { $0.luminanceAdjustmentAqua = 30 }),
            ("luminanceAdjustmentBlue", { $0.luminanceAdjustmentBlue = 30 }),
            ("luminanceAdjustmentPurple", { $0.luminanceAdjustmentPurple = 30 }),
            ("luminanceAdjustmentMagenta", { $0.luminanceAdjustmentMagenta = 30 }),
        ]

        for (label, mutate) in mutations {
            var m = AdjustmentModel.default
            mutate(&m)
            let mutated = try keyThroughSidecarRoundTrip(m, assetID: id)
            XCTAssertNotEqual(
                base, mutated,
                "cache key must change when \(label) changes — pre-#1916 it did not, so the slider returned stale cached pixels"
            )
        }
    }

    /// Serialize `model` to a real `.xmp` in the temp dir, read it back, and
    /// build a cache key from the PARSED model. No sidecar mocking — the
    /// bytes hit disk and go back through `XMPParser`.
    private func keyThroughSidecarRoundTrip(
        _ model: AdjustmentModel,
        assetID: UUID
    ) throws -> SceneLinearChainCache.Key {
        let xml = XMPSerializer.serialize(model: model, culling: CullingState())
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("scenelinearcache-rt-\(UUID().uuidString).xmp")
        try xml.write(to: url, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: url) }
        let xmlBack = try String(contentsOf: url, encoding: .utf8)
        let (parsed, _) = try XMPParser.parse(xmlBack)
        return SceneLinearChainCache.make(
            assetID: assetID, model: parsed,
            decodedTemperature: 6500, decodedTint: 0,
            skipAgX: false, width: 1920, height: 1080
        )
    }

    /// The post-FFI sliders (sharpen* / nrColor / captureSharpening*)
    /// must NOT change the key — that's the whole point of the cache.
    /// When the user drags Sharpness the hash matches the previous
    /// tick, the FFI is skipped, and only the Metal kernels execute.
    func testPostFFISlidersExcludedFromKey() {
        let id = UUID()
        let base = SceneLinearChainCache.make(
            assetID: id, model: .default,
            decodedTemperature: 6500, decodedTint: 0,
            skipAgX: false, width: 1920, height: 1080
        )

        let mutations: [(String, (inout AdjustmentModel) -> Void)] = [
            ("sharpenAmount",            { $0.sharpenAmount = 80 }),
            ("sharpenRadius",            { $0.sharpenRadius = 2.0 }),
            ("sharpenDetail",            { $0.sharpenDetail = 70 }),
            ("sharpenMasking",           { $0.sharpenMasking = 50 }),
            ("nrColor",                  { $0.nrColor = 75 }),
            ("captureSharpeningAmount",  { $0.captureSharpeningAmount = 50 }),
            ("captureSharpeningSigma",   { $0.captureSharpeningSigma = 1.5 }),
        ]

        for (label, mutate) in mutations {
            var m = AdjustmentModel.default
            mutate(&m)
            let mutated = SceneLinearChainCache.make(
                assetID: id, model: m,
                decodedTemperature: 6500, decodedTint: 0,
                skipAgX: false, width: 1920, height: 1080
            )
            XCTAssertEqual(
                base, mutated,
                "key must NOT change when \(label) changes — that's the whole point of the cache"
            )
        }
    }

    /// AssetID change invalidates the key (asset B's slider values
    /// must not falsely hit asset A's cached pixels).
    func testAssetIDIsInKey() {
        let model = AdjustmentModel.default
        let a = SceneLinearChainCache.make(
            assetID: UUID(), model: model,
            decodedTemperature: 6500, decodedTint: 0,
            skipAgX: false, width: 1920, height: 1080
        )
        let b = SceneLinearChainCache.make(
            assetID: UUID(), model: model,
            decodedTemperature: 6500, decodedTint: 0,
            skipAgX: false, width: 1920, height: 1080
        )
        XCTAssertNotEqual(a, b)
    }

    /// Extent (width/height) is in the key — the fast pass renders at
    /// viewport size, the refine pass at full size, both with the
    /// same model. Without the extent in the key, an unchanged-model
    /// refine would silently return preview-resolution pixels.
    func testExtentIsInKey() {
        let id = UUID()
        let model = AdjustmentModel.default
        let preview = SceneLinearChainCache.make(
            assetID: id, model: model,
            decodedTemperature: 6500, decodedTint: 0,
            skipAgX: false, width: 1920, height: 1080
        )
        let refine = SceneLinearChainCache.make(
            assetID: id, model: model,
            decodedTemperature: 6500, decodedTint: 0,
            skipAgX: false, width: 4032, height: 3024
        )
        XCTAssertNotEqual(preview, refine)
    }

    /// The three FFI args (decodedTemperature, decodedTint, skipAgX)
    /// are in the key — same model can render differently when the
    /// decoded baseline shifts (sidecar vs no-sidecar), or when the
    /// AgX tail is bypassed (non-RAW path).
    func testFFIParamsAreInKey() {
        let id = UUID()
        let m = AdjustmentModel.default
        let base = SceneLinearChainCache.make(
            assetID: id, model: m,
            decodedTemperature: 6500, decodedTint: 0,
            skipAgX: false, width: 1920, height: 1080
        )
        let diffTemp = SceneLinearChainCache.make(
            assetID: id, model: m,
            decodedTemperature: 4500, decodedTint: 0,
            skipAgX: false, width: 1920, height: 1080
        )
        let diffTint = SceneLinearChainCache.make(
            assetID: id, model: m,
            decodedTemperature: 6500, decodedTint: 10,
            skipAgX: false, width: 1920, height: 1080
        )
        let diffAgX = SceneLinearChainCache.make(
            assetID: id, model: m,
            decodedTemperature: 6500, decodedTint: 0,
            skipAgX: true, width: 1920, height: 1080
        )
        XCTAssertNotEqual(base, diffTemp)
        XCTAssertNotEqual(base, diffTint)
        XCTAssertNotEqual(base, diffAgX)
    }

    // MARK: - LRU surface

    /// `get` returns the value `put` stored — basic put/get sanity.
    /// Verifies CIImage reference identity is preserved (the cache
    /// retains the exact CIImage pointer it was handed, no wrapping
    /// or copying).
    func testGetReturnsPutValue() {
        let cache = SceneLinearChainCache()
        let key = SceneLinearChainCache.Key(
            assetID: UUID(), modelDigest: 0xCAFE, width: 100, height: 100
        )
        let value = CIImage(color: CIColor(red: 0.5, green: 0.5, blue: 0.5))
        cache.put(key, value)
        let got = cache.get(key)
        XCTAssertNotNil(got)
        XCTAssertTrue(got === value, "cache must return the same CIImage reference")
    }

    /// `put` evicts the previous slot — this is a single-entry LRU,
    /// not a multi-entry one. A second put on a different key replaces
    /// the first; the first key now misses.
    func testPutEvictsPreviousSlot() {
        let cache = SceneLinearChainCache()
        let keyA = SceneLinearChainCache.Key(
            assetID: UUID(), modelDigest: 1, width: 100, height: 100
        )
        let keyB = SceneLinearChainCache.Key(
            assetID: UUID(), modelDigest: 2, width: 100, height: 100
        )
        let valueA = CIImage(color: CIColor(red: 1, green: 0, blue: 0))
        let valueB = CIImage(color: CIColor(red: 0, green: 1, blue: 0))

        cache.put(keyA, valueA)
        cache.put(keyB, valueB)

        XCTAssertNil(cache.get(keyA), "single-entry LRU evicts on put")
        XCTAssertNotNil(cache.get(keyB))
    }

    /// Miss on a key that was never stored.
    func testGetReturnsNilOnMiss() {
        let cache = SceneLinearChainCache()
        let key = SceneLinearChainCache.Key(
            assetID: UUID(), modelDigest: 1, width: 100, height: 100
        )
        XCTAssertNil(cache.get(key))
    }

    /// `invalidate` drops the slot.
    func testInvalidateClearsSlot() {
        let cache = SceneLinearChainCache()
        let key = SceneLinearChainCache.Key(
            assetID: UUID(), modelDigest: 1, width: 100, height: 100
        )
        let value = CIImage(color: .black)
        cache.put(key, value)
        XCTAssertNotNil(cache.get(key))
        cache.invalidate()
        XCTAssertNil(cache.get(key))
    }
}
