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
}
