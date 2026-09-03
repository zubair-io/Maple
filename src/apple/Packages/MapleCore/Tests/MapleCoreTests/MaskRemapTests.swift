// MaskRemapTests.swift — the crop-space remap (#355): evaluating the
// remapped mask at a crop-normalized point must give the weight raw-core
// gets from the original mask at the corresponding full-frame point.

import XCTest

@testable import MapleCore

final class MaskRemapTests: XCTestCase {
    private let native = CGSize(width: 6000, height: 4000)

    private let linear = LocalMask.linear(
        start: MaskPoint(x: 0.2, y: 0.3), end: MaskPoint(x: 0.8, y: 0.7), feather: 0.4)
    private let radial = LocalMask.radial(
        center: MaskPoint(x: 0.55, y: 0.45), radii: MaskPoint(x: 0.25, y: 0.15),
        angle: 0.6, feather: 0.6, invert: false)

    private let samples: [(Double, Double)] = [
        (0, 0), (1, 1), (0.5, 0.5), (0.1, 0.9), (0.9, 0.1), (0.33, 0.66), (0.75, 0.25), (0.05, 0.5),
    ]

    private func assertWeightIdentity(_ mask: LocalMask, crop: Crop, file: StaticString = #filePath, line: UInt = #line) {
        let affine = MaskAffine.cropToFullFrame(crop, nativeSize: native)
        let remapped = MaskRemap.remapped(
            [LocalAdjustment(mask: mask, adjustments: PartialAdjustments())],
            appliedCrop: crop, nativeSize: native)[0].mask
        for (u, v) in samples {
            let full = affine.apply(MaskPoint(x: u, y: v))
            let expected = MaskWeight.evaluate(mask, x: full.x, y: full.y)
            let got = MaskWeight.evaluate(remapped, x: u, y: v)
            XCTAssertEqual(got, expected, accuracy: 1e-9,
                           "crop \(crop) sample (\(u), \(v))", file: file, line: line)
        }
    }

    func testIdentityCropLeavesTheStackUntouched() {
        let layers = [LocalAdjustment(mask: linear, adjustments: PartialAdjustments(exposure: 1))]
        XCTAssertEqual(MaskRemap.remapped(layers, appliedCrop: .identity, nativeSize: native), layers)
        XCTAssertTrue(MaskAffine.cropToFullFrame(.identity, nativeSize: native).isIdentity)
    }

    func testAxisAlignedCropMapsCornersOntoTheCropRect() {
        let crop = Crop(top: 0.1, left: 0.2, bottom: 0.7, right: 0.9, angle: 0)
        let affine = MaskAffine.cropToFullFrame(crop, nativeSize: native)
        let origin = affine.apply(MaskPoint(x: 0, y: 0))
        let far = affine.apply(MaskPoint(x: 1, y: 1))
        XCTAssertEqual(origin.x, 0.2, accuracy: 1e-12)
        XCTAssertEqual(origin.y, 0.1, accuracy: 1e-12)
        XCTAssertEqual(far.x, 0.9, accuracy: 1e-12)
        XCTAssertEqual(far.y, 0.7, accuracy: 1e-12)
    }

    func testInverseUndoesTheMap() {
        let crop = Crop(top: 0.1, left: 0.2, bottom: 0.7, right: 0.9, angle: 7)
        let affine = MaskAffine.cropToFullFrame(crop, nativeSize: native)
        let inverse = try! XCTUnwrap(affine.inverted())
        let p = MaskPoint(x: 0.37, y: 0.81)
        let back = inverse.apply(affine.apply(p))
        XCTAssertEqual(back.x, p.x, accuracy: 1e-12)
        XCTAssertEqual(back.y, p.y, accuracy: 1e-12)
    }

    func testLinearWeightIsInvariantUnderAnAspectChangingCrop() {
        assertWeightIdentity(linear, crop: Crop(top: 0.1, left: 0.2, bottom: 0.7, right: 0.9, angle: 0))
    }

    func testRadialWeightIsInvariantUnderAnAspectChangingCrop() {
        assertWeightIdentity(radial, crop: Crop(top: 0.25, left: 0.05, bottom: 0.95, right: 0.5, angle: 0))
    }

    func testLinearWeightIsInvariantUnderAStraightenedCrop() {
        assertWeightIdentity(linear, crop: Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 12))
    }

    func testRadialWeightIsInvariantUnderAStraightenedCrop() {
        assertWeightIdentity(radial, crop: Crop(top: 0.15, left: 0.2, bottom: 0.85, right: 0.7, angle: -9))
    }

    func testInvertedRadialStaysInverted() {
        let inverted = LocalMask.radial(
            center: MaskPoint(x: 0.5, y: 0.5), radii: MaskPoint(x: 0.2, y: 0.3),
            angle: 0.2, feather: 0.3, invert: true)
        assertWeightIdentity(inverted, crop: Crop(top: 0.2, left: 0.1, bottom: 0.8, right: 0.95, angle: 4))
    }

    func testAdjustmentsRideAlongUnchanged() {
        let adjustments = PartialAdjustments(exposure: 0.5, tint: -3)
        let out = MaskRemap.remapped(
            [LocalAdjustment(mask: radial, adjustments: adjustments)],
            appliedCrop: Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 0), nativeSize: native)
        XCTAssertEqual(out[0].adjustments, adjustments)
    }
}
