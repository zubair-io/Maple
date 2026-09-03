// MaskWeightTests.swift — the Swift port of raw-core's mask evaluator
// (#355), pinned at the same analytic points `mask.rs`'s tests check.

import XCTest

@testable import MapleCore

final class MaskWeightTests: XCTestCase {
    private let hardLinear = LocalMask.linear(
        start: MaskPoint(x: 0, y: 0.5), end: MaskPoint(x: 1, y: 0.5), feather: 0)
    private let softLinear = LocalMask.linear(
        start: MaskPoint(x: 0, y: 0.5), end: MaskPoint(x: 1, y: 0.5), feather: 1)

    func testHardLinearIsAStepAtTheMidpoint() {
        XCTAssertEqual(MaskWeight.evaluate(hardLinear, x: 0.25, y: 0.5), 0)
        XCTAssertEqual(MaskWeight.evaluate(hardLinear, x: 0.75, y: 0.5), 1)
        XCTAssertEqual(MaskWeight.evaluate(hardLinear, x: 0.5, y: 0.1), 1, "on the step ⇒ 1, independent of y")
    }

    func testFullFeatherLinearIsASmoothstepAcrossTheWholeLength() {
        XCTAssertEqual(MaskWeight.evaluate(softLinear, x: 0, y: 0.5), 0)
        XCTAssertEqual(MaskWeight.evaluate(softLinear, x: 1, y: 0.5), 1)
        XCTAssertEqual(MaskWeight.evaluate(softLinear, x: 0.5, y: 0.5), 0.5, accuracy: 1e-12)
        // smoothstep(0.25) = 3·0.0625 − 2·0.015625 = 0.15625
        XCTAssertEqual(MaskWeight.evaluate(softLinear, x: 0.25, y: 0.5), 0.15625, accuracy: 1e-12)
    }

    func testHalfFeatherLinearBandIsCenteredOnTheMidpoint() {
        let mask = LocalMask.linear(start: MaskPoint(x: 0, y: 0), end: MaskPoint(x: 1, y: 0), feather: 0.5)
        XCTAssertEqual(MaskWeight.evaluate(mask, x: 0.25, y: 0), 0)
        XCTAssertEqual(MaskWeight.evaluate(mask, x: 0.75, y: 0), 1)
        XCTAssertEqual(MaskWeight.evaluate(mask, x: 0.5, y: 0), 0.5, accuracy: 1e-12)
    }

    func testDegenerateLinearWeighsZeroEverywhere() {
        let mask = LocalMask.linear(start: MaskPoint(x: 0.5, y: 0.5), end: MaskPoint(x: 0.5, y: 0.5), feather: 0.5)
        XCTAssertEqual(MaskWeight.evaluate(mask, x: 0.9, y: 0.9), 0)
    }

    func testHardRadialIsOneInsideZeroOutside() {
        let mask = LocalMask.radial(
            center: MaskPoint(x: 0.5, y: 0.5), radii: MaskPoint(x: 0.25, y: 0.25),
            angle: 0, feather: 0, invert: false)
        XCTAssertEqual(MaskWeight.evaluate(mask, x: 0.5, y: 0.5), 1)
        XCTAssertEqual(MaskWeight.evaluate(mask, x: 0.7, y: 0.5), 1)
        XCTAssertEqual(MaskWeight.evaluate(mask, x: 0.9, y: 0.5), 0)
    }

    func testRadialFeatherFallsOffFromTheInnerRadiusToTheBoundary() {
        let mask = LocalMask.radial(
            center: MaskPoint(x: 0.5, y: 0.5), radii: MaskPoint(x: 0.4, y: 0.4),
            angle: 0, feather: 0.5, invert: false)
        // d = 0.5 ⇒ inside the inner radius (1 − feather = 0.5) ⇒ 1.
        XCTAssertEqual(MaskWeight.evaluate(mask, x: 0.7, y: 0.5), 1, accuracy: 1e-12)
        // d = 0.75 ⇒ halfway through the band ⇒ 1 − smoothstep(0.5) = 0.5.
        XCTAssertEqual(MaskWeight.evaluate(mask, x: 0.8, y: 0.5), 0.5, accuracy: 1e-12)
        // d = 1 ⇒ boundary ⇒ 0.
        XCTAssertEqual(MaskWeight.evaluate(mask, x: 0.9, y: 0.5), 0, accuracy: 1e-12)
    }

    func testInvertFlipsTheRadialSense() {
        let mask = LocalMask.radial(
            center: MaskPoint(x: 0.5, y: 0.5), radii: MaskPoint(x: 0.25, y: 0.25),
            angle: 0, feather: 0, invert: true)
        XCTAssertEqual(MaskWeight.evaluate(mask, x: 0.5, y: 0.5), 0)
        XCTAssertEqual(MaskWeight.evaluate(mask, x: 0.9, y: 0.5), 1)
    }

    func testRadialRotationTurnsTheEllipseInNormalizedSpace() {
        // rx = 0.4 along the local x axis, ry = 0.1; rotated 90° the long
        // axis lies along y.
        let mask = LocalMask.radial(
            center: MaskPoint(x: 0.5, y: 0.5), radii: MaskPoint(x: 0.4, y: 0.1),
            angle: .pi / 2, feather: 0, invert: false)
        XCTAssertEqual(MaskWeight.evaluate(mask, x: 0.5, y: 0.85), 1)
        XCTAssertEqual(MaskWeight.evaluate(mask, x: 0.85, y: 0.5), 0)
    }
}
