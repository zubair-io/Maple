// FFIInputBufferCacheTests.swift — unit coverage for #1959's single-entry
// cache around the per-tick FFI input readback.
//
// The load-bearing case is the ADDRESS-RECYCLING seam (PR #2083 review):
// `FFIInputBufferCache.Key.decodedID` is an `ObjectIdentifier` — just the
// object's address. After the decoded CIImage deallocates (asset switch,
// decode replacement), a NEW CIImage can allocate at the recycled address
// and match the stale key at the same viewport dims. The cache defends
// with a weak identity anchor: `get` requires the slot's weakly-held
// `decoded` reference to still be `===` the caller's live instance, so a
// nil (deallocated) or different-object anchor forces a miss regardless
// of key equality. These tests exercise that seam directly — a tiny
// in-memory data structure, no fixtures required, so they run as part of
// the default `swift test` inner loop (mirrors
// `SceneLinearChainCacheTests`).

import Foundation
import XCTest
import CoreImage
@testable import MapleCore

final class FFIInputBufferCacheTests: XCTestCase {

    /// A distinct CIImage instance per call — `CIImage(color:)` allocates
    /// a fresh object each time, which is all these identity tests need.
    private func makeImage() -> CIImage {
        CIImage(color: .gray)
    }

    // MARK: - Hit path

    /// Store with instance A, read with the SAME key and the SAME live
    /// instance — must hit and return the exact bytes.
    func testHitOnSameInstanceAndDims() {
        let cache = FFIInputBufferCache()
        let image = makeImage()
        let key = FFIInputBufferCache.Key(
            decodedID: ObjectIdentifier(image), width: 1920, height: 1080
        )
        let bytes = Data([1, 2, 3, 4])

        cache.put(key, bytes, decoded: image)
        XCTAssertEqual(cache.get(key, decoded: image), bytes)
    }

    /// Same live instance, different target dims — the key differs, so
    /// a refine pass at another size must miss rather than reuse
    /// fast-phase bytes.
    func testMissOnDifferentDims() {
        let cache = FFIInputBufferCache()
        let image = makeImage()
        let fastKey = FFIInputBufferCache.Key(
            decodedID: ObjectIdentifier(image), width: 1920, height: 1080
        )
        cache.put(fastKey, Data([9]), decoded: image)

        let refineKey = FFIInputBufferCache.Key(
            decodedID: ObjectIdentifier(image), width: 3840, height: 2160
        )
        XCTAssertNil(cache.get(refineKey, decoded: image))
    }

    // MARK: - Identity anchor (the address-recycling seam)

    /// The recycling scenario: store with image A, release A, then probe
    /// with a hand-constructed key carrying A's OLD ObjectIdentifier (as
    /// a recycled allocation at the same address would produce) and a
    /// NEW instance B. The weak anchor is nil after A deallocates, so
    /// `slot.decoded === decoded` fails and the cache must MISS — even
    /// though the key compares equal.
    func testMissAfterOriginalInstanceDeallocates() {
        let cache = FFIInputBufferCache()

        // Capture A's identifier, populate the cache, then let A die.
        // The create/put runs inside an autoreleasepool so any
        // autoreleased reference to A dies with the pool — otherwise the
        // weak anchor could linger past the `nil`-out below.
        weak var weakA: CIImage?
        var staleKey: FFIInputBufferCache.Key!
        autoreleasepool {
            let imageA = makeImage()
            weakA = imageA
            staleKey = FFIInputBufferCache.Key(
                decodedID: ObjectIdentifier(imageA), width: 1920, height: 1080
            )
            cache.put(staleKey, Data([7, 7, 7]), decoded: imageA)
            // Sanity: hits while A is alive.
            XCTAssertNotNil(cache.get(staleKey, decoded: imageA))
        }
        XCTAssertNil(weakA, "test precondition: A must have deallocated")

        // Simulate the recycled-address false-hit attempt: a NEW image B
        // probing with A's old identifier-based key. In production this
        // is B allocating at A's freed address, so ObjectIdentifier(B)
        // == staleID; here we construct the same key by hand — the key
        // comparison is identical either way, and the weak-nil anchor is
        // what must reject it.
        let imageB = makeImage()
        XCTAssertNil(
            cache.get(staleKey, decoded: imageB),
            "a key matching a deallocated instance's address must never serve the old bytes"
        )
    }

    /// Anchor-vs-caller mismatch with BOTH objects alive: the slot is
    /// anchored to A, the probe passes B with a key built from A's
    /// identifier. Key equality alone would hit; the `===` anchor
    /// comparison must reject it.
    func testMissWhenCallerInstanceDiffersFromAnchor() {
        let cache = FFIInputBufferCache()
        let imageA = makeImage()
        let keyA = FFIInputBufferCache.Key(
            decodedID: ObjectIdentifier(imageA), width: 1920, height: 1080
        )
        cache.put(keyA, Data([5]), decoded: imageA)

        let imageB = makeImage()
        XCTAssertNil(cache.get(keyA, decoded: imageB))
        // A itself still hits — the anchor rejects only foreign callers.
        XCTAssertEqual(cache.get(keyA, decoded: imageA), Data([5]))
    }

    // MARK: - Single-slot surface

    /// A second put evicts the first slot (single-entry bound).
    func testPutEvictsPreviousSlot() {
        let cache = FFIInputBufferCache()
        let first = makeImage()
        let firstKey = FFIInputBufferCache.Key(
            decodedID: ObjectIdentifier(first), width: 100, height: 100
        )
        cache.put(firstKey, Data([1]), decoded: first)

        let second = makeImage()
        let secondKey = FFIInputBufferCache.Key(
            decodedID: ObjectIdentifier(second), width: 200, height: 200
        )
        cache.put(secondKey, Data([2]), decoded: second)

        XCTAssertNil(cache.get(firstKey, decoded: first))
        XCTAssertEqual(cache.get(secondKey, decoded: second), Data([2]))
    }

    /// `invalidate` drops the slot.
    func testInvalidateDropsSlot() {
        let cache = FFIInputBufferCache()
        let image = makeImage()
        let key = FFIInputBufferCache.Key(
            decodedID: ObjectIdentifier(image), width: 10, height: 10
        )
        cache.put(key, Data([3]), decoded: image)
        cache.invalidate()
        XCTAssertNil(cache.get(key, decoded: image))
    }

    // MARK: - Bounded-target gate (#2042)

    /// An UNBOUNDED (nil-`targetSize`) render — the export / full-res
    /// preview shape — must leave the cache slot untouched: a `put`
    /// there would pin a full-resolution f32 buffer (~1.6 GB at 100 MP)
    /// in the single slot until the next put, against the #2042
    /// export-memory bounding. The call sites gate by passing
    /// `decodedSource: nil` when `targetSize` is nil, which skips both
    /// the lookup and the populate.
    func testNilTargetRenderDoesNotPopulateCache() {
        let pipeline = ImageEditPipeline()
        let decoded = CIImage(color: CIColor(red: 0.25, green: 0.5, blue: 0.75))
            .cropped(to: CGRect(x: 0, y: 0, width: 64, height: 64))

        _ = pipeline.processSceneLinear(
            decoded: decoded,
            model: .default,
            targetSize: nil,
            assetID: UUID()
        )
        XCTAssertTrue(
            pipeline.ffiInputBufferCache.isEmpty,
            "a nil-targetSize (full-res) render must not populate the input cache (#2042)"
        )

        _ = pipeline.processSceneLinearNonRaw(
            decoded: decoded,
            model: .default,
            targetSize: nil,
            assetID: UUID()
        )
        XCTAssertTrue(
            pipeline.ffiInputBufferCache.isEmpty,
            "the non-RAW nil-targetSize path must not populate the input cache either (#2042)"
        )
    }

    /// Positive control for the gate: a BOUNDED (non-nil `targetSize`)
    /// render — the slider drag-tick shape — populates the cache on the
    /// readback success path.
    func testBoundedTargetRenderPopulatesCache() {
        let pipeline = ImageEditPipeline()
        let decoded = CIImage(color: CIColor(red: 0.25, green: 0.5, blue: 0.75))
            .cropped(to: CGRect(x: 0, y: 0, width: 64, height: 64))

        _ = pipeline.processSceneLinear(
            decoded: decoded,
            model: .default,
            targetSize: CGSize(width: 32, height: 32),
            assetID: UUID()
        )
        XCTAssertFalse(
            pipeline.ffiInputBufferCache.isEmpty,
            "a bounded (viewport-target) render must populate the input cache"
        )
    }

    /// The weak anchor must not extend the decoded image's lifetime —
    /// the #2037 memory-pressure teardown relies on the decode buffer
    /// actually freeing when RenderActor drops it.
    func testCacheDoesNotRetainDecodedImage() {
        let cache = FFIInputBufferCache()
        weak var weakImage: CIImage?
        autoreleasepool {
            let image = makeImage()
            weakImage = image
            let key = FFIInputBufferCache.Key(
                decodedID: ObjectIdentifier(image), width: 10, height: 10
            )
            cache.put(key, Data([4]), decoded: image)
        }
        XCTAssertNil(weakImage, "the cache must hold its identity anchor weakly")
    }
}
