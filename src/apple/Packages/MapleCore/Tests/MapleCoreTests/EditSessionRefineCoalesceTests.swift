// EditSessionRefineCoalesceTests.swift — Ticket 10 item H — coalesce
// concurrent refine decodes by `(asset, target)`.
//
// The stale-gen bail-out (commit `d4eed05`) catches the easy case where
// a newer schedule lands BEFORE the prior task entered the synchronous
// Rust call. The coalescer fixes the harder race: two refine schedules
// that both pass the gen check, both enter `decodeSceneLinearSized` in
// parallel, and waste one of the calls because only the second result
// publishes. These tests use a fake decoder closure that counts
// invocations so we can assert "N concurrent schedules → 1 underlying
// decode" without standing up the real Rust pipeline.
//
// Slice 2 of issue #194: `coalescedRefineDecode` moved off EditSession
// onto `RenderActor`. Tests call `await session.renderActor.…`.

import XCTest
import CoreImage
@testable import MapleCore

@MainActor
final class EditSessionRefineCoalesceTests: XCTestCase {

    // MARK: - Helpers

    /// Synthesise a writable temp `.dng` so `AssetRef(url:)` has a real
    /// file path to key against. The bytes don't matter — the coalescer
    /// never invokes the Rust pipeline; it only routes through the
    /// closure we hand it.
    private func makeAsset() throws -> AssetRef {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("coalesce.dng")
        try Data([0x44, 0x4E, 0x47]).write(to: url)
        return AssetRef(url: url)
    }

    /// Minimal CIImage stand-in for the decode result.
    private func fakeDecode(width: Int, height: Int) -> CIImage {
        CIImage(color: .gray)
            .cropped(to: CGRect(x: 0, y: 0, width: width, height: height))
    }

    // MARK: - Tests

    /// Two concurrent refines for the same `(asset, target)` must
    /// collapse to one underlying decode.
    func testConcurrentRefinesForSameTargetCollapseToSingleDecode() async throws {
        let asset = try makeAsset()
        let session = EditSession(asset: asset)
        let actor = session.renderActor

        let target = CGSize(width: 4000, height: 3000)
        let counter = DecodeCounter()

        async let a = actor.coalescedRefineDecode(asset: asset, target: target) { [counter] in
            await counter.increment()
            try? await Task.sleep(for: .milliseconds(50))
            return CIImage(color: .red).cropped(to: CGRect(x: 0, y: 0, width: 4000, height: 3000))
        }
        async let b = actor.coalescedRefineDecode(asset: asset, target: target) { [counter] in
            await counter.increment()
            try? await Task.sleep(for: .milliseconds(50))
            return CIImage(color: .red).cropped(to: CGRect(x: 0, y: 0, width: 4000, height: 3000))
        }
        let (resultA, resultB) = await (a, b)

        let count = await counter.value
        XCTAssertEqual(count, 1, "expected 1 underlying decode for two concurrent same-target refines, got \(count)")
        XCTAssertNotNil(resultA)
        XCTAssertNotNil(resultB)
        XCTAssertEqual(resultA?.extent, resultB?.extent)
    }

    /// Many (10) concurrent refines for the same target — coalescer
    /// should still produce a single underlying decode.
    func testTenConcurrentRefinesForSameTargetCollapseToSingleDecode() async throws {
        let asset = try makeAsset()
        let session = EditSession(asset: asset)
        let actor = session.renderActor

        let target = CGSize(width: 1500, height: 1000)
        let counter = DecodeCounter()

        await withTaskGroup(of: CIImage?.self) { group in
            for _ in 0..<10 {
                group.addTask { [counter, actor, asset, target, fakeDecode] in
                    await actor.coalescedRefineDecode(asset: asset, target: target) { [counter] in
                        await counter.increment()
                        try? await Task.sleep(for: .milliseconds(75))
                        return await fakeDecode(1500, 1000)
                    }
                }
            }
            for await _ in group {}
        }

        let count = await counter.value
        XCTAssertEqual(count, 1, "expected 1 underlying decode for 10 concurrent same-target refines, got \(count)")
    }

    /// Distinct target sizes must NOT collapse.
    func testRefinesForDifferentTargetsDoNotCollapse() async throws {
        let asset = try makeAsset()
        let session = EditSession(asset: asset)
        let actor = session.renderActor

        let counter = DecodeCounter()

        async let small = actor.coalescedRefineDecode(
            asset: asset, target: CGSize(width: 800, height: 600)
        ) { [counter] in
            await counter.increment()
            try? await Task.sleep(for: .milliseconds(50))
            return CIImage(color: .blue).cropped(to: CGRect(x: 0, y: 0, width: 800, height: 600))
        }
        async let big = actor.coalescedRefineDecode(
            asset: asset, target: CGSize(width: 4000, height: 3000)
        ) { [counter] in
            await counter.increment()
            try? await Task.sleep(for: .milliseconds(50))
            return CIImage(color: .blue).cropped(to: CGRect(x: 0, y: 0, width: 4000, height: 3000))
        }
        _ = await (small, big)

        let count = await counter.value
        XCTAssertEqual(count, 2, "expected 2 decodes for two different-sized refines, got \(count)")
    }

    /// Floating-point jitter on the target size (1500.0 vs 1500.0001)
    /// must STILL collapse — the keys round to integer pixel widths.
    func testRefinesWithFloatingPointJitterCollapse() async throws {
        let asset = try makeAsset()
        let session = EditSession(asset: asset)
        let actor = session.renderActor

        let counter = DecodeCounter()

        async let exact = actor.coalescedRefineDecode(
            asset: asset, target: CGSize(width: 1500.0, height: 1000.0)
        ) { [counter] in
            await counter.increment()
            try? await Task.sleep(for: .milliseconds(50))
            return CIImage(color: .green).cropped(to: CGRect(x: 0, y: 0, width: 1500, height: 1000))
        }
        async let jitter = actor.coalescedRefineDecode(
            asset: asset, target: CGSize(width: 1500.0001, height: 1000.0001)
        ) { [counter] in
            await counter.increment()
            try? await Task.sleep(for: .milliseconds(50))
            return CIImage(color: .green).cropped(to: CGRect(x: 0, y: 0, width: 1500, height: 1000))
        }
        _ = await (exact, jitter)

        let count = await counter.value
        XCTAssertEqual(count, 1, "expected fp-jitter-equivalent targets to coalesce, got \(count) decodes")
    }

    /// A refine that lands AFTER its predecessor finishes must run a
    /// fresh decode — the in-flight slot was cleared on completion.
    func testSequentialRefinesDoNotShareCompletedDecode() async throws {
        let asset = try makeAsset()
        let session = EditSession(asset: asset)
        let actor = session.renderActor

        let target = CGSize(width: 1500, height: 1000)
        let counter = DecodeCounter()

        let _ = await actor.coalescedRefineDecode(asset: asset, target: target) { [counter] in
            await counter.increment()
            return CIImage(color: .yellow).cropped(to: CGRect(x: 0, y: 0, width: 1500, height: 1000))
        }
        let _ = await actor.coalescedRefineDecode(asset: asset, target: target) { [counter] in
            await counter.increment()
            return CIImage(color: .yellow).cropped(to: CGRect(x: 0, y: 0, width: 1500, height: 1000))
        }

        let count = await counter.value
        XCTAssertEqual(count, 2, "expected 2 decodes for two sequential refines (no in-flight overlap), got \(count)")
    }

    /// `invalidate()` clears the coalescer dictionary so a fresh refine
    /// after the cache invalidation runs against the new state, not
    /// piggy-backing on a stale in-flight task.
    func testInvalidateDecodedCacheClearsCoalescer() async throws {
        let asset = try makeAsset()
        let session = EditSession(asset: asset)
        let actor = session.renderActor

        let target = CGSize(width: 1500, height: 1000)
        let counter = DecodeCounter()

        // Start a decode, but invalidate before the second arrival.
        async let first = actor.coalescedRefineDecode(asset: asset, target: target) { [counter] in
            await counter.increment()
            try? await Task.sleep(for: .milliseconds(100))
            return CIImage(color: .cyan).cropped(to: CGRect(x: 0, y: 0, width: 1500, height: 1000))
        }
        // Yield so the first task registers in the dictionary, then
        // invalidate the actor directly (synchronous fence on the
        // actor, vs. the fire-and-forget public sync forwarder).
        try? await Task.sleep(for: .milliseconds(20))
        await actor.invalidate()
        // Second arrival should NOT join the cleared slot — runs its own.
        let _ = await actor.coalescedRefineDecode(asset: asset, target: target) { [counter] in
            await counter.increment()
            return CIImage(color: .cyan).cropped(to: CGRect(x: 0, y: 0, width: 1500, height: 1000))
        }
        _ = await first

        let count = await counter.value
        XCTAssertEqual(count, 2, "expected invalidate to break the join — first + post-invalidate second = 2 decodes, got \(count)")
    }
}

/// Tiny actor-backed counter so the decode closures can increment from
/// any actor isolation without races. Sendable because actors are.
private actor DecodeCounter {
    private var count = 0

    func increment() {
        count += 1
    }

    var value: Int { count }
}
