// ToneCurveFlattenTests.swift — the FFI point layout for tone curves (#367).
//
// `GpuLiveSession.flattened(_:)` is the Swift side of a raw pointer contract:
// `raw-ffi`'s `read_points` reads `tone_curve_*_ptr` as a flat, interleaved
// `[x0, y0, x1, y1, …]` f32 buffer whose length is `2 × pointCount`. Nothing
// about that layout is expressed in a type, so it is pinned here.
//
// It is also the reason this function was rewritten. The original built the
// buffer with `flatMap { [Float($0.x), Float($0.y)] }`, which allocates a
// throwaway two-element array per control point and then grows the result as
// it appends. That runs four times (luma + R/G/B) on every
// `withGpuLiveParams`, which is once per live render tick of a curve drag —
// allocation inside the render loop, which CLAUDE.md § Performance invariants
// forbids. The replacement builds one exactly-sized buffer via
// `unsafeUninitializedCapacity`.
//
// A rewrite of a pointer-layout function under a performance constraint is
// exactly where an off-by-one or a transposed axis hides, so these tests
// compare against an independent oracle rather than against a restatement of
// the implementation.

import XCTest

@testable import MapleCore

final class ToneCurveFlattenTests: XCTestCase {

    /// The layout `read_points` expects, written the obvious (slow) way.
    /// Deliberately NOT the shape the implementation uses — an oracle that
    /// mirrors the code under test proves nothing.
    private func referenceFlatten(_ curve: ToneCurve) -> [Float] {
        curve.points.flatMap { [Float($0.x), Float($0.y)] }
    }

    // MARK: - Layout

    func testIdentityCurveFlattensToEmpty() {
        // The FFI reads a zero length as "no curve", which is what lets an
        // unedited model take the stage's short-circuit.
        XCTAssertEqual(GpuLiveSession.flattened(.identity), [])
        XCTAssertEqual(GpuLiveSession.flattened(ToneCurve(points: [])), [])
    }

    func testPointsInterleaveXThenY() {
        let curve = ToneCurve(points: [(x: 0.0, y: 0.25), (x: 0.5, y: 0.5), (x: 1.0, y: 0.75)])
        // Interleaved, in list order, x before y.
        XCTAssertEqual(GpuLiveSession.flattened(curve), [0.0, 0.25, 0.5, 0.5, 1.0, 0.75])
    }

    func testLengthIsAlwaysTwiceThePointCount() {
        for count in 1...16 {
            let points = (0..<count).map { index -> ToneCurvePoint in
                let t = Double(index) / Double(count)
                return (x: t, y: 1.0 - t)
            }
            XCTAssertEqual(
                GpuLiveSession.flattened(ToneCurve(points: points)).count,
                count * 2,
                "flattened length must be 2 × pointCount for \(count) points"
            )
        }
    }

    func testAxesAreNotTransposed() {
        // A curve whose x and y differ at every knot: a transposed write would
        // still produce the right LENGTH, so length alone cannot catch it.
        let curve = ToneCurve(points: [(x: 0.1, y: 0.9), (x: 0.2, y: 0.8)])
        let flat = GpuLiveSession.flattened(curve)
        XCTAssertEqual(flat[0], 0.1, accuracy: 1e-6)
        XCTAssertEqual(flat[1], 0.9, accuracy: 1e-6)
        XCTAssertEqual(flat[2], 0.2, accuracy: 1e-6)
        XCTAssertEqual(flat[3], 0.8, accuracy: 1e-6)
    }

    // MARK: - Behaviour is unchanged by the allocation fix

    func testMatchesTheReferenceOnAMultiPointCurve() {
        // The realistic case: a many-knot curve of the kind a drag authors.
        let points = (0..<32).map { index -> ToneCurvePoint in
            let t = Double(index) / 31.0
            // An S-curve, so no two coordinates coincide by accident.
            return (x: t, y: t * t * (3.0 - 2.0 * t))
        }
        let curve = ToneCurve(points: points)
        XCTAssertEqual(GpuLiveSession.flattened(curve), referenceFlatten(curve))
    }

    func testMatchesTheReferenceOnEdgeAndOutOfDomainValues() {
        // Nothing in `flattened` clamps, and it must not start: the authoring
        // domain is enforced by the editor, and the stage owns the mapping.
        // Values outside [0, 1] and the Double→Float narrowing must pass
        // through exactly as the reference does.
        let curve = ToneCurve(points: [
            (x: 0.0, y: 0.0),
            (x: 1.0, y: 1.0),
            (x: -0.25, y: 1.5),
            (x: 1.0 / 3.0, y: 2.0 / 3.0),
        ])
        XCTAssertEqual(GpuLiveSession.flattened(curve), referenceFlatten(curve))
    }

    func testSinglePointCurveIsNotSpecialCased() {
        let curve = ToneCurve(points: [(x: 0.42, y: 0.58)])
        XCTAssertEqual(GpuLiveSession.flattened(curve), referenceFlatten(curve))
        XCTAssertEqual(GpuLiveSession.flattened(curve).count, 2)
    }
}
