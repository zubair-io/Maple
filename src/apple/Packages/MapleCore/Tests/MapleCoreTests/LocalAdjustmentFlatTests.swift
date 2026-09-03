// LocalAdjustmentFlatTests.swift — the flat layer wire (#355) pinned against
// raw-core's `types/local_adjustment/flat.rs` slot map.

import XCTest

@testable import MapleCore

final class LocalAdjustmentFlatTests: XCTestCase {
    private func allControls() -> PartialAdjustments {
        PartialAdjustments(
            exposure: 0.75, contrast: -30, highlights: 45, shadows: -12.5, whites: 8,
            blacks: -60, saturation: 22, vibrance: -5, temperature: 1500, tint: -9)
    }

    func testEmptyStackIsAnEmptyWire() {
        XCTAssertEqual(LocalAdjustmentFlat.flatten([]), [])
    }

    func testLinearLayerSlotMap() {
        let layer = LocalAdjustment(
            mask: .linear(start: MaskPoint(x: 0.125, y: 0.25), end: MaskPoint(x: 0.875, y: 0.75), feather: 0.375),
            adjustments: allControls())
        let flat = LocalAdjustmentFlat.flatten([layer])
        XCTAssertEqual(flat.count, LocalAdjustmentFlat.layerLength)
        XCTAssertEqual(Array(flat[0..<8]), [0.125, 0.25, 0.875, 0.75, 0.375, 0, 0, 0])
        // Every control set ⇒ all ten presence bits.
        XCTAssertEqual(flat[8], 1023)
        XCTAssertEqual(Array(flat[9..<12]), [0, 0, 0])
        XCTAssertEqual(Array(flat[12..<22]), [0.75, -30, 45, -12.5, 8, -60, 22, -5, 1500, -9])
        XCTAssertEqual(Array(flat[22..<24]), [0, 0])
    }

    func testRadialLayerSlotMapIncludingAngleAndInvert() {
        let layer = LocalAdjustment(
            mask: .radial(center: MaskPoint(x: 0.4, y: 0.6), radii: MaskPoint(x: 0.3, y: 0.2),
                          angle: 1.25, feather: 0.5, invert: true),
            adjustments: PartialAdjustments())
        let flat = LocalAdjustmentFlat.flatten([layer])
        XCTAssertEqual(flat[0], 0.4, accuracy: 1e-6)
        XCTAssertEqual(flat[1], 0.6, accuracy: 1e-6)
        XCTAssertEqual(flat[2], 0.3, accuracy: 1e-6)
        XCTAssertEqual(flat[3], 0.2, accuracy: 1e-6)
        XCTAssertEqual(flat[4], 0.5)
        XCTAssertEqual(flat[5], 1.25)
        XCTAssertEqual(flat[6], 1, "kind = radial")
        XCTAssertEqual(flat[7], 1, "invert")
        XCTAssertEqual(flat[8], 0, "no control set ⇒ empty presence mask")
        XCTAssertEqual(Array(flat[12..<22]), [Float](repeating: 0, count: 10))
    }

    /// `nil` and `0` are different wire values: presence bit clear vs. set.
    func testAbsentControlsAreDistinctFromZero() {
        let sparse = LocalAdjustment(
            mask: .linear(start: MaskPoint(x: 0, y: 0), end: MaskPoint(x: 1, y: 1), feather: 0.5),
            adjustments: PartialAdjustments(saturation: 0))
        let flat = LocalAdjustmentFlat.flatten([sparse])
        XCTAssertEqual(flat[8], 64, "bit 6 = saturation")
        XCTAssertEqual(flat[18], 0)
    }

    func testLayersAreLaidOutInOrderAtTheFixedStride() {
        let a = LocalAdjustment(
            mask: .linear(start: MaskPoint(x: 0, y: 0), end: MaskPoint(x: 1, y: 0), feather: 0.5),
            adjustments: PartialAdjustments(exposure: 1))
        let b = LocalAdjustment(
            mask: .radial(center: MaskPoint(x: 0.5, y: 0.5), radii: MaskPoint(x: 0.2, y: 0.2),
                          angle: 0, feather: 0.5, invert: false),
            adjustments: PartialAdjustments(exposure: -1))
        let flat = LocalAdjustmentFlat.flatten([a, b])
        XCTAssertEqual(flat.count, 48)
        XCTAssertEqual(flat[6], 0)
        XCTAssertEqual(flat[12], 1)
        XCTAssertEqual(flat[24 + 6], 1)
        XCTAssertEqual(flat[24 + 12], -1)
    }
}
