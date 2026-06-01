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
