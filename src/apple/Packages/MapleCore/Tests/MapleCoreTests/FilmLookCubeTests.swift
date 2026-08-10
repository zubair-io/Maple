// FilmLookCubeTests.swift — cube-bake math for the CPU/CIImage film-look
// composite (epic #2683, closing the #2713 CPU-chain gap for the
// interactive canvas — see `FilmLookCube.swift`'s doc comment).
//
// These test the LATTICE MATH (`colorCubeFilter`'s node values), not a
// rendered pixel — no `CIContext`/GPU round-trip, so they run everywhere
// `swift test` runs, no fixtures required.

import CoreImage
import XCTest
@testable import MapleCore

final class FilmLookCubeTests: XCTestCase {

    /// `((b*n+g)*n+r)*3+c` — the ordering `FilmLutStore`/`maple_film_lut_decode`
    /// produce and `colorCubeFilter` consumes.
    private func identityLattice(size n: Int) -> [Float] {
        let denom = Float(n - 1)
        var data = [Float](repeating: 0, count: n * n * n * 3)
        var i = 0
        for b in 0..<n {
            for g in 0..<n {
                for r in 0..<n {
                    data[i] = Float(r) / denom
                    data[i + 1] = Float(g) / denom
                    data[i + 2] = Float(b) / denom
                    i += 3
                }
            }
        }
        return data
    }

    /// A synthetic, non-identity, non-monochrome lattice — mirrors
    /// `film_look.rs`'s own `synthetic_lattice` test fixture so the strength
    /// midpoint test below has something genuinely different from identity
    /// to lerp toward.
    private func syntheticLattice(size n: Int) -> [Float] {
        let denom = Float(n - 1)
        var data = [Float](repeating: 0, count: n * n * n * 3)
        var i = 0
        for b in 0..<n {
            let bf = Float(b) / denom
            for g in 0..<n {
                let gf = Float(g) / denom
                for r in 0..<n {
                    let rf = Float(r) / denom
                    data[i] = min(max(gf * 0.6 + 0.2, 0), 1)
                    data[i + 1] = min(max(bf * 0.5 + 0.3, 0), 1)
                    data[i + 2] = min(max(rf * 0.4 + 0.1, 0), 1)
                    i += 3
                }
            }
        }
        return data
    }

    /// Reads back one node's RGB from the baked RGBA cube data
    /// `colorCubeFilter` hands to `CIColorCubeWithColorSpace`.
    private func node(_ data: Data, size n: Int, r: Int, g: Int, b: Int) -> (Float, Float, Float) {
        let idx = ((b * n + g) * n + r) * 4
        return data.withUnsafeBytes { buf -> (Float, Float, Float) in
            let floats = buf.bindMemory(to: Float.self)
            return (floats[idx], floats[idx + 1], floats[idx + 2])
        }
    }

    // MARK: - Identity lattice → identity cube

    /// An identity `.mlut` (node value == node coordinate) at full strength
    /// bakes to an identity cube: `identity + (identity - identity) * 1 ==
    /// identity`, matching raw-core's own
    /// `identity_lattice_at_full_strength_is_noop_within_1e6_for_in_gamut`.
    func testIdentityLatticeAtFullStrengthBakesIdentityCube() throws {
        let n = 5
        let lattice = identityLattice(size: n)
        let filter = try XCTUnwrap(FilmLookCube.colorCubeFilter(size: n, film: lattice, strengthPct: 100))
        let cubeData = try XCTUnwrap(filter.value(forKey: "inputCubeData") as? Data)

        let denom = Float(n - 1)
        for b in 0..<n {
            for g in 0..<n {
                for r in 0..<n {
                    let (rr, gg, bb) = node(cubeData, size: n, r: r, g: g, b: b)
                    XCTAssertEqual(rr, Float(r) / denom, accuracy: 1e-6)
                    XCTAssertEqual(gg, Float(g) / denom, accuracy: 1e-6)
                    XCTAssertEqual(bb, Float(b) / denom, accuracy: 1e-6)
                }
            }
        }
    }

    /// Strength 0 is also an identity cube, whatever the lattice — matches
    /// raw-core's `strength_zero_is_bit_exact_noop`. `FilmLookCube.apply`
    /// itself short-circuits before even building the filter (tested
    /// separately below); this checks the underlying bake is ALSO identity
    /// so the two guards agree.
    func testSyntheticLatticeAtZeroStrengthBakesIdentityCube() throws {
        let n = 5
        let lattice = syntheticLattice(size: n)
        let filter = try XCTUnwrap(FilmLookCube.colorCubeFilter(size: n, film: lattice, strengthPct: 0))
        let cubeData = try XCTUnwrap(filter.value(forKey: "inputCubeData") as? Data)
        let denom = Float(n - 1)
        let (r, g, b) = node(cubeData, size: n, r: 3, g: 1, b: 4)
        XCTAssertEqual(r, 3 / denom, accuracy: 1e-6)
        XCTAssertEqual(g, 1 / denom, accuracy: 1e-6)
        XCTAssertEqual(b, 4 / denom, accuracy: 1e-6)
    }

    // MARK: - Strength midpoint

    /// Strength 50 is the exact midpoint between identity and the full-look
    /// node value — `strength_is_linear_in_display_linear_domain`'s Swift
    /// analogue (this bakes the lerp per-node rather than per-pixel, but the
    /// linearity claim is the same arithmetic).
    func testStrength50IsExactMidpointBetweenIdentityAndLook() throws {
        let n = 5
        let lattice = syntheticLattice(size: n)
        let filter = try XCTUnwrap(FilmLookCube.colorCubeFilter(size: n, film: lattice, strengthPct: 50))
        let cubeData = try XCTUnwrap(filter.value(forKey: "inputCubeData") as? Data)

        let denom = Float(n - 1)
        let (r, g, b) = (2, 3, 1)
        let identity = (Float(r) / denom, Float(g) / denom, Float(b) / denom)
        let srcIndex = ((b * n + g) * n + r) * 3
        let look = (lattice[srcIndex], lattice[srcIndex + 1], lattice[srcIndex + 2])
        let expected = (
            (identity.0 + look.0) / 2,
            (identity.1 + look.1) / 2,
            (identity.2 + look.2) / 2
        )

        let got = node(cubeData, size: n, r: r, g: g, b: b)
        XCTAssertEqual(got.0, expected.0, accuracy: 1e-6)
        XCTAssertEqual(got.1, expected.1, accuracy: 1e-6)
        XCTAssertEqual(got.2, expected.2, accuracy: 1e-6)
    }

    // MARK: - Never crash on a missing/malformed lattice

    func testApplyWithNilLatticeReturnsImageUnchanged() {
        let image = CIImage(color: .red).cropped(to: CGRect(x: 0, y: 0, width: 4, height: 4))
        let result = FilmLookCube.apply(to: image, lattice: nil, strengthPct: 100)
        XCTAssertEqual(result, image)
    }

    func testApplyWithZeroStrengthReturnsImageUnchanged() {
        let image = CIImage(color: .red).cropped(to: CGRect(x: 0, y: 0, width: 4, height: 4))
        let lattice = (data: identityLattice(size: 5), size: 5, key: UInt32(1))
        let result = FilmLookCube.apply(to: image, lattice: lattice, strengthPct: 0)
        XCTAssertEqual(result, image)
    }

    /// A malformed lattice (element count doesn't match `size`) must never
    /// crash — `colorCubeFilter` returns `nil` and `apply` falls back to the
    /// untouched image, matching every other "missing look" fallback in this
    /// area (`FilmLutStore.lattice`, `syncFilmLutForPresent`).
    func testColorCubeFilterReturnsNilOnMismatchedLatticeSize() {
        let malformed = [Float](repeating: 0, count: 10) // not size³·3 for any size > 1
        XCTAssertNil(FilmLookCube.colorCubeFilter(size: 5, film: malformed, strengthPct: 100))
    }

    func testColorCubeFilterReturnsNilOnDegenerateSize() {
        XCTAssertNil(FilmLookCube.colorCubeFilter(size: 1, film: [0, 0, 0], strengthPct: 100))
        XCTAssertNil(FilmLookCube.colorCubeFilter(size: 0, film: [], strengthPct: 100))
    }

    func testApplyWithMalformedLatticeReturnsImageUnchanged() {
        let image = CIImage(color: .red).cropped(to: CGRect(x: 0, y: 0, width: 4, height: 4))
        let lattice = (data: [Float](repeating: 0, count: 10), size: 5, key: UInt32(1))
        let result = FilmLookCube.apply(to: image, lattice: lattice, strengthPct: 100)
        XCTAssertEqual(result, image)
    }
}
