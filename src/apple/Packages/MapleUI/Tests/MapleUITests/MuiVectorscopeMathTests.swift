import XCTest
@testable import MapleUI

final class MuiVectorscopeMathTests: XCTestCase {
    func testPureGreyHasZeroChroma() {
        let chroma = MuiVectorscopeMath.chroma(r: 0.5, g: 0.5, b: 0.5)
        XCTAssertEqual(chroma.cb, 0, accuracy: 1e-9)
        XCTAssertEqual(chroma.cr, 0, accuracy: 1e-9)
    }

    func testPureGreyMapsToCanvasCenter() {
        let chroma = MuiVectorscopeMath.chroma(r: 0.5, g: 0.5, b: 0.5)
        let center = CGPoint(x: 32, y: 32)
        let point = MuiVectorscopeMath.canvasPoint(cb: chroma.cb, cr: chroma.cr, center: center, radius: 28)
        XCTAssertEqual(point.x, center.x, accuracy: 1e-9)
        XCTAssertEqual(point.y, center.y, accuracy: 1e-9)
    }

    func testPureBluePushesCbPositive() {
        let chroma = MuiVectorscopeMath.chroma(r: 0, g: 0, b: 1)
        XCTAssertGreaterThan(chroma.cb, 0)
    }

    func testPureRedPushesCrPositive() {
        let chroma = MuiVectorscopeMath.chroma(r: 1, g: 0, b: 0)
        XCTAssertGreaterThan(chroma.cr, 0)
    }

    func testCanvasPointCbGrowsRightCrGrowsUp() {
        let center = CGPoint(x: 50, y: 50)
        let right = MuiVectorscopeMath.canvasPoint(cb: 0.2, cr: 0, center: center, radius: 40)
        XCTAssertGreaterThan(right.x, center.x)

        let up = MuiVectorscopeMath.canvasPoint(cb: 0, cr: 0.2, center: center, radius: 40)
        XCTAssertLessThan(up.y, center.y)
    }

    func testRec709ChromaMatchesRec601AtGreyButDivergesForSaturatedBlue() {
        let grey = MuiVectorscopeMath.chromaRec709(r: 0.5, g: 0.5, b: 0.5)
        XCTAssertEqual(grey.cb, 0, accuracy: 1e-9)
        XCTAssertEqual(grey.cr, 0, accuracy: 1e-9)
        let rec709 = MuiVectorscopeMath.chromaRec709(r: 0, g: 0, b: 1)
        let rec601 = MuiVectorscopeMath.chroma(r: 0, g: 0, b: 1)
        // `cb`'s B-channel coefficient is exactly 0.5 in BOTH BT.601 and
        // Rec.709 (a shared property of how Cb is normalized in both
        // standards) — for PURE blue, r=g=0, so the standards' only real
        // difference (the R/G coefficients) never engages and cb is
        // identical between them. `cr`'s B-channel coefficient genuinely
        // differs (-0.081312 BT.601 vs -0.045847 Rec.709), so that's the
        // axis that actually demonstrates the divergence for this colour.
        XCTAssertEqual(rec709.cb, rec601.cb, accuracy: 1e-9, "cb's B coefficient is shared by both standards")
        XCTAssertNotEqual(rec709.cr, rec601.cr, accuracy: 1e-6)
    }

    func testTargetAnglesGoMonotonicallyAroundTheWheelOnceAndSumTo360() {
        // Real broadcast vectorscope targets are NOT evenly spaced at 60° —
        // the eye's non-uniform hue sensitivity is baked into the Rec.709
        // matrix coefficients (verified: alternating ~54°/~72° gaps, not a
        // uniform hexagon). The invariant that actually holds is rotational
        // order: walking the six targets (and back to the first) sweeps
        // forward each step and covers exactly one full lap in total.
        let angles = VectorscopeTarget.allCases.map(MuiVectorscopeMath.targetAngleDeg)
        var totalSweep = 0.0
        for i in 0..<angles.count {
            let next = angles[(i + 1) % angles.count]
            var gap = next - angles[i]
            if gap <= 0 { gap += 360 }
            XCTAssertGreaterThan(gap, 30, "gap after target \(i) is implausibly small")
            XCTAssertLessThan(gap, 90, "gap after target \(i) is implausibly large")
            totalSweep += gap
        }
        XCTAssertEqual(totalSweep, 360, accuracy: 1e-6)
    }

    func testRedAt3OClockRotatesTheRedTargetToZeroDegrees() {
        let redAngle = MuiVectorscopeMath.targetAngleDeg(.red)
        let rotated = MuiVectorscopeMath.rotated(cb: cos(redAngle * .pi / 180), cr: sin(redAngle * .pi / 180), by: -redAngle)
        XCTAssertEqual(rotated.cb, 1, accuracy: 1e-6)
        XCTAssertEqual(rotated.cr, 0, accuracy: 1e-6)
    }

    func testSkinToneLineAngleMatchesTheCoreRangePresetHue() {
        // The graticule's skin line must point at the SAME 55° Oklab-adjacent
        // convention RangeRefinement.skinTone uses (spec §11: "a graticule
        // convention at 123°, not a colour-space derivation" — this pins the
        // CONSTANT, not a derivation from the Oklab preset, which is
        // deliberate: the two are independently chosen and happen to both
        // target real skin).
        XCTAssertEqual(MuiVectorscopeMath.skinToneLineAngleDeg, 123.0, accuracy: 0.01)
    }

    func testBinCentresTileTheChromaSquareExactly() {
        // 4 × 4: centres at ±0.125 / ±0.375, so cells of width 0.25 span
        // exactly [-0.5, 0.5] — no half-cell bleed past the edge.
        let topLeft = MuiVectorscopeMath.binCentre(row: 0, col: 0, n: 4)
        XCTAssertEqual(topLeft.cb, -0.375, accuracy: 1e-12)
        XCTAssertEqual(topLeft.cr, 0.375, accuracy: 1e-12)
        let bottomRight = MuiVectorscopeMath.binCentre(row: 3, col: 3, n: 4)
        XCTAssertEqual(bottomRight.cb, 0.375, accuracy: 1e-12)
        XCTAssertEqual(bottomRight.cr, -0.375, accuracy: 1e-12)
        XCTAssertEqual(topLeft.cb - 0.125, -0.5, accuracy: 1e-12)
        XCTAssertEqual(bottomRight.cb + 0.125, 0.5, accuracy: 1e-12)
    }
}

extension MuiVectorscopeMathTests {
    /// The hue ring must agree with the target dots: at each of the six
    /// broadcast target angles the ring's colour is that target's own pure
    /// RGB. This is the assertion that stops the ring drifting against the
    /// markers — the failure mode a uniform-hexagon gradient would have,
    /// since the real targets alternate ~54/72 degree gaps.
    func testRingColourMatchesEachTargetAtItsOwnAngle() {
        for target in VectorscopeTarget.allCases {
            let angle = MuiVectorscopeMath.targetAngleDeg(target)
            let ring = MuiVectorscopeMath.ringRGB(atAngleDeg: angle)
            let want = MuiVectorscopeMath.targetRGB(target)
            XCTAssertEqual(ring.r, want.r, accuracy: 0.001, "\(target) red")
            XCTAssertEqual(ring.g, want.g, accuracy: 0.001, "\(target) green")
            XCTAssertEqual(ring.b, want.b, accuracy: 0.001, "\(target) blue")
        }
    }

    /// Halfway between two adjacent targets the ring is a genuine blend of
    /// both — not snapped to either end.
    func testRingColourBlendsBetweenAdjacentTargets() {
        let red = MuiVectorscopeMath.targetAngleDeg(.red)
        let yellow = MuiVectorscopeMath.targetAngleDeg(.yellow)
        // Counter-clockwise from red (~103 degrees) to yellow (~175), so
        // the midpoint walks forward from RED, not from yellow.
        let mid = MuiVectorscopeMath.normalizedDeg(
            red + MuiVectorscopeMath.normalizedDeg(yellow - red) / 2)
        let ring = MuiVectorscopeMath.ringRGB(atAngleDeg: mid)
        // Red->yellow differ only in green, so the blend is a partial green.
        XCTAssertEqual(ring.r, 1.0, accuracy: 0.001)
        XCTAssertGreaterThan(ring.g, 0.2)
        XCTAssertLessThan(ring.g, 0.8)
    }

    /// Angles outside 0..<360 fold in rather than falling off the ring.
    func testRingColourWrapsAroundFullTurns() {
        let base = MuiVectorscopeMath.ringRGB(atAngleDeg: 40)
        for equivalent in [400.0, -320.0, 760.0] {
            let wrapped = MuiVectorscopeMath.ringRGB(atAngleDeg: equivalent)
            XCTAssertEqual(wrapped.r, base.r, accuracy: 0.001, "\(equivalent)")
            XCTAssertEqual(wrapped.g, base.g, accuracy: 0.001, "\(equivalent)")
            XCTAssertEqual(wrapped.b, base.b, accuracy: 0.001, "\(equivalent)")
        }
    }
}
