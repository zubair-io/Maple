// FilmLutStoreTests.swift — `.mlut` load/decode + LRU cache (epic #2683,
// Task 10).
//
// `Fixtures/film-luts/test_lut.mlut` is a tiny hand-built 2³ grid (56 bytes:
// the 8-byte v1 header + 24 f16 values `0.0, 0.05, 0.1, …`, see
// `raw_core::film`'s format doc) — small enough to hand-verify by eye,
// exercising the real `maple_film_lut_decode` FFI without needing one of
// the 100 real 33³ catalog assets.

import XCTest
import RawPipeline
@testable import MapleCore

final class FilmLutStoreTests: XCTestCase {

    /// The real FFI decode path, against the tiny fixture bundled into the
    /// test target (`Bundle.module`, not `.main` — the production default).
    func testResolvesAKnownIdToItsDecodedLattice() {
        let store = FilmLutStore(bundle: .module)
        let resolved = store.lattice(for: "test_lut")
        XCTAssertNotNil(resolved)
        guard let (data, size, key) = resolved else { return }
        XCTAssertEqual(size, 2)
        XCTAssertEqual(data.count, 2 * 2 * 2 * 3)
        // f16 round-trip loses precision past ~3 significant digits —
        // `accuracy` absorbs that, not a bug in the fixture or the decoder.
        XCTAssertEqual(data[0], 0.0, accuracy: 0.001)
        XCTAssertEqual(data[1], 0.05, accuracy: 0.001)
        XCTAssertEqual(data.last!, 1.15, accuracy: 0.002)
        XCTAssertNotEqual(key, 0, "FNV-1a key must never collide with the reserved 0 = 'none' sentinel")
    }

    /// An id with no matching `.mlut` resolves to `nil` — never a crash or
    /// an error thrown; the render falls back to identity.
    func testMissingIdResolvesToNil() {
        let store = FilmLutStore(bundle: .module)
        XCTAssertNil(store.lattice(for: "does_not_exist_in_the_catalog"))
    }

    /// An empty id (the model default — "no look") resolves to `nil`
    /// without even touching the bundle.
    func testEmptyIdResolvesToNil() {
        let store = FilmLutStore(bundle: .module)
        XCTAssertNil(store.lattice(for: ""))
    }

    /// A repeat lookup for the SAME id hits the one-entry LRU and returns
    /// byte-identical data without re-touching the FFI (observable only
    /// indirectly here — the assertion is correctness of the cached value,
    /// not a call-count seam, since `FilmLutStore` has no test hook for
    /// that; the raw-ffi decode itself is deterministic so a second call
    /// producing the same bytes is a reasonable proxy either way).
    func testRepeatLookupForSameIdReturnsSameData() {
        let store = FilmLutStore(bundle: .module)
        let first = store.lattice(for: "test_lut")
        let second = store.lattice(for: "test_lut")
        XCTAssertEqual(first?.data, second?.data)
        XCTAssertEqual(first?.size, second?.size)
        XCTAssertEqual(first?.key, second?.key)
    }

    /// Switching to a different (missing) id after a hit evicts the old
    /// entry rather than leaking stale bytes under the new id.
    func testSwitchingToAMissingIdAfterAHitEvictsTheCache() {
        let store = FilmLutStore(bundle: .module)
        XCTAssertNotNil(store.lattice(for: "test_lut"))
        XCTAssertNil(store.lattice(for: "does_not_exist_in_the_catalog"))
        // Switching back re-decodes rather than reading a stale eviction.
        XCTAssertNotNil(store.lattice(for: "test_lut"))
    }

    /// FNV-1a is deterministic and id-sensitive — two different ids never
    /// collide for the small fixed set of strings this test drives (a hash
    /// COULD collide in general, but not for this pair, and never lands on
    /// the reserved 0 sentinel).
    func testFnv1aHashIsDeterministicAndNonZero() {
        let a = FilmLutStore.fnv1aHash("color_negative_kodak_portra_400")
        let b = FilmLutStore.fnv1aHash("color_negative_kodak_portra_400")
        let c = FilmLutStore.fnv1aHash("black_white_kodak_tri_x_400")
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
        XCTAssertNotEqual(a, 0)
        XCTAssertNotEqual(c, 0)
    }
}
