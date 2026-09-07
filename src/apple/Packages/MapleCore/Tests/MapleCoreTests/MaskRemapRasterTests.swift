// MaskRemapRasterTests.swift — bitmap masks through the buffer-space remap
// (#355): the resample rule, and the per-session registry-id bookkeeping.

import CoreGraphics
import XCTest

@testable import MapleCore

final class MaskRemapRasterTests: XCTestCase {
    /// An 8×8 raster whose value is 30 × column, so a sample's column
    /// position is readable straight off its value.
    private func columnRamp() -> MaskRemapRasterCache.Raster {
        var bytes = [UInt8](repeating: 0, count: 64)
        for y in 0..<8 { for x in 0..<8 { bytes[y * 8 + x] = UInt8(x * 30) } }
        return (8, 8, bytes)
    }

    func testIdentityAffineReproducesTheSourceExactly() {
        let source = columnRamp()
        let out = MaskRemapRasterCache.resample(source, through: .identity)
        XCTAssertEqual(out.width, 8)
        XCTAssertEqual(out.height, 8)
        XCTAssertEqual(out.bytes, source.bytes)
    }

    /// The right half of the frame as a native-detail window: derived
    /// texel 0 sits on source column 4, the last on column 7, the middle
    /// halfway between columns 5 and 6 — raw-core's bilinear rule.
    func testWindowAffineResamplesTheCoveredColumns() {
        let affine = MaskAffine.windowToFullFrame(
            window: CGRect(x: 4, y: 0, width: 4, height: 8), fullSize: CGSize(width: 8, height: 8))
        let out = MaskRemapRasterCache.resample(columnRamp(), through: affine)
        XCTAssertEqual(out.width, 3)
        XCTAssertEqual(out.height, 8)
        XCTAssertEqual(out.bytes[0], 120)
        XCTAssertEqual(out.bytes[1], 165)
        XCTAssertEqual(out.bytes[2], 210)
        XCTAssertEqual(out.bytes[7 * 3 + 2], 210)
    }

    /// Sampling the derived raster over the buffer reads what raw-core
    /// reads from the source over the frame — at the derived texel centres
    /// exactly (up to the u8 quantisation both sides share).
    func testDerivedRasterMatchesSourceThroughTheAffine() {
        let source = columnRamp()
        let affine = MaskAffine.cropToFullFrame(
            Crop(top: 0.25, left: 0.125, bottom: 1, right: 0.75, angle: 0),
            nativeSize: CGSize(width: 8, height: 8))
        let out = MaskRemapRasterCache.resample(source, through: affine)
        for j in 0..<out.height {
            for i in 0..<out.width {
                let u = Double(i) / Double(out.width - 1)
                let v = Double(j) / Double(out.height - 1)
                let full = affine.apply(MaskPoint(x: u, y: v))
                let expected = MaskWeight.sample(width: 8, height: 8, bytes: source.bytes, x: full.x, y: full.y)
                let got = MaskWeight.sample(width: out.width, height: out.height, bytes: out.bytes, x: u, y: v)
                XCTAssertEqual(got, expected, accuracy: 0.5 / 255, "texel (\(i), \(j))")
            }
        }
    }

    func testDerivedSizeFollowsTheFrameFractionEachAxisSpans() {
        let half = MaskAffine.windowToFullFrame(
            window: CGRect(x: 0, y: 0, width: 512, height: 256), fullSize: CGSize(width: 1024, height: 1024))
        let size = MaskRemapRasterCache.derivedSize(source: (1024, 768), through: half)
        // 1024 · 511/1023 = 511.4995 → 511; 768 · 255/1023 = 191.4 → 191.
        XCTAssertEqual(size.width, 511)
        XCTAssertEqual(size.height, 191)
        let tiny = MaskRemapRasterCache.derivedSize(
            source: (1024, 768), through: MaskAffine(a: 0, b: 0, c: 0, d: 0, tx: 0.5, ty: 0.5))
        XCTAssertEqual(tiny.width, 2)
        XCTAssertEqual(tiny.height, 2)
    }

    func testDerivedDigestIsSixteenHexCharsAndKeyedOnTheAffine() {
        let a = MaskRemapRasterCache.Key(digest: "0123456789abcdef", affine: .identity)
        let b = MaskRemapRasterCache.Key(
            digest: "0123456789abcdef", affine: MaskAffine(a: 0.5, b: 0, c: 0, d: 0.5, tx: 0.1, ty: 0.2))
        let da = MaskRemapRasterCache.derivedDigest(for: a)
        let db = MaskRemapRasterCache.derivedDigest(for: b)
        XCTAssertEqual(da.count, 16)
        XCTAssertTrue(da.allSatisfy { "0123456789abcdef".contains($0) })
        XCTAssertNotEqual(da, db)
        XCTAssertEqual(db, MaskRemapRasterCache.derivedDigest(for: b))
    }

    // MARK: - Registry bookkeeping

    private final class Released: @unchecked Sendable {
        private let lock = NSLock()
        private var ids: [UInt32] = []
        func record(_ id: UInt32) { lock.lock(); ids.append(id); lock.unlock() }
        var all: [UInt32] { lock.lock(); defer { lock.unlock() }; return ids }
    }

    private func key(_ n: Int) -> MaskRemapRasterCache.Key {
        MaskRemapRasterCache.Key(digest: "0123456789abcdef", affine: MaskAffine(a: 1, b: 0, c: 0, d: 1, tx: Double(n), ty: 0))
    }

    func testLeastRecentlyUsedEntryIsReleasedPastCapacity() {
        let released = Released()
        let cache = MaskRemapRasterCache(release: { released.record($0) })
        for n in 0..<MaskRemapRasterCache.capacity { cache.insert(UInt32(100 + n), for: key(n)) }
        XCTAssertEqual(cache.count, MaskRemapRasterCache.capacity)
        // Touch the oldest so it becomes the most recent; the second-oldest
        // is what the next insert must evict.
        XCTAssertEqual(cache.id(for: key(0)), 100)
        cache.insert(999, for: key(MaskRemapRasterCache.capacity))
        XCTAssertEqual(released.all, [101])
        XCTAssertEqual(cache.count, MaskRemapRasterCache.capacity)
        XCTAssertEqual(cache.id(for: key(0)), 100)
        XCTAssertNil(cache.id(for: key(1)))
    }

    func testDuplicateInsertKeepsTheFirstIdAndReleasesTheNewcomer() {
        let released = Released()
        let cache = MaskRemapRasterCache(release: { released.record($0) })
        cache.insert(5, for: key(0))
        cache.insert(6, for: key(0))
        XCTAssertEqual(cache.id(for: key(0)), 5)
        XCTAssertEqual(released.all, [6])
    }

    func testTeardownReleasesEveryHeldId() {
        let released = Released()
        var cache: MaskRemapRasterCache? = MaskRemapRasterCache(release: { released.record($0) })
        cache?.insert(1, for: key(0))
        cache?.insert(2, for: key(1))
        cache = nil
        XCTAssertEqual(Set(released.all), [1, 2])
    }
}
