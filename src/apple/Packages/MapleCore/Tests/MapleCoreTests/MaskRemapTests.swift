// MaskRemapTests.swift — the buffer-space remap (#355): evaluating the
// remapped mask at a buffer-normalized point must give the weight raw-core
// gets from the original mask at the corresponding full-frame point, for
// the GPU-live crop affine and the native-detail window affine alike.

import CoreImage
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

    private func assertWeightIdentity(
        _ mask: LocalMask, through affine: MaskAffine, file: StaticString = #filePath, line: UInt = #line
    ) {
        let remapped = MaskRemap.remappedGeometry(
            [LocalAdjustment(mask: mask, adjustments: PartialAdjustments())], through: affine)[0].mask
        for (u, v) in samples {
            let full = affine.apply(MaskPoint(x: u, y: v))
            let expected = MaskWeight.evaluate(mask, x: full.x, y: full.y)
            let got = MaskWeight.evaluate(remapped, x: u, y: v)
            XCTAssertEqual(got, expected, accuracy: 1e-9,
                           "affine \(affine) sample (\(u), \(v))", file: file, line: line)
        }
    }

    private func cropAffine(_ crop: Crop) -> MaskAffine {
        MaskAffine.cropToFullFrame(crop, nativeSize: native)
    }

    // MARK: - The crop affine

    func testIdentityCropIsTheIdentityMapAndLeavesTheStackUntouched() {
        let layers = [LocalAdjustment(mask: linear, adjustments: PartialAdjustments(exposure: 1))]
        XCTAssertTrue(cropAffine(.identity).isIdentity)
        XCTAssertEqual(MaskRemap.remappedGeometry(layers, through: .identity), layers)
    }

    func testAxisAlignedCropMapsCornersOntoTheCanonicalCropRect() throws {
        let crop = Crop(top: 0.1, left: 0.2, bottom: 0.7, right: 0.9, angle: 0)
        let affine = cropAffine(crop)
        // The same rounded-once rect `CropImageStage.apply` cuts (#2117),
        // converted from its y-up form to top-left normalized edges.
        let rect = try XCTUnwrap(CropImageStage.cropRect(crop, bufferSize: native, nativeSize: native))
        let left = Double(rect.minX / native.width)
        let right = Double(rect.maxX / native.width)
        let top = Double((native.height - rect.maxY) / native.height)
        let bottom = Double((native.height - rect.minY) / native.height)
        let origin = affine.apply(MaskPoint(x: 0, y: 0))
        let far = affine.apply(MaskPoint(x: 1, y: 1))
        XCTAssertEqual(origin.x, left, accuracy: 1e-12)
        XCTAssertEqual(origin.y, top, accuracy: 1e-12)
        XCTAssertEqual(far.x, right, accuracy: 1e-12)
        XCTAssertEqual(far.y, bottom, accuracy: 1e-12)
    }

    func testInverseUndoesTheMap() throws {
        let affine = cropAffine(Crop(top: 0.1, left: 0.2, bottom: 0.7, right: 0.9, angle: 7))
        let inverse = try XCTUnwrap(affine.inverted())
        let p = MaskPoint(x: 0.37, y: 0.81)
        let back = inverse.apply(affine.apply(p))
        XCTAssertEqual(back.x, p.x, accuracy: 1e-12)
        XCTAssertEqual(back.y, p.y, accuracy: 1e-12)
    }

    /// The straighten direction is pinned against `CropImageStage.apply`
    /// itself, not against a transcription of it: a single bright block is
    /// cropped and straightened through the real stage, found in the
    /// output, and its output position pushed back through the affine must
    /// land on where the block was. A sign slip in either rotation would
    /// send it to the mirrored corner.
    func testStraightenDirectionMatchesCropImageStage() throws {
        let size = CGSize(width: 200, height: 100)
        let block = CGRect(x: 150, y: 30, width: 4, height: 4)  // top-left pixel coords
        var pixels = [UInt8](repeating: 40, count: Int(size.width * size.height) * 4)
        for y in Int(block.minY)..<Int(block.maxY) {
            for x in Int(block.minX)..<Int(block.maxX) {
                let i = (y * Int(size.width) + x) * 4
                pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255
            }
        }
        for i in stride(from: 3, to: pixels.count, by: 4) { pixels[i] = 255 }
        let provider = try XCTUnwrap(CGDataProvider(data: Data(pixels) as CFData))
        let cg = try XCTUnwrap(CGImage(
            width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: Int(size.width) * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
        let crop = Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 12)
        let out = CropImageStage.apply(crop, to: CIImage(cgImage: cg), nativeSize: size)
        let bounds = out.extent.integral
        let w = Int(bounds.width), h = Int(bounds.height)
        var rgba = [UInt8](repeating: 0, count: w * h * 4)
        let context = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
        rgba.withUnsafeMutableBytes { buf in
            context.render(out, toBitmap: buf.baseAddress!, rowBytes: w * 4, bounds: bounds,
                           format: .RGBA8, colorSpace: nil)
        }
        // `render(toBitmap:)` writes rows top-down. Centroid of the bright pixels.
        var sumX = 0.0, sumY = 0.0, n = 0.0
        for y in 0..<h {
            for x in 0..<w where rgba[(y * w + x) * 4] > 200 {
                sumX += Double(x) + 0.5; sumY += Double(y) + 0.5; n += 1
            }
        }
        XCTAssertGreaterThan(n, 4, "the block vanished from the straightened crop")
        let predicted = MaskAffine.cropToFullFrame(crop, nativeSize: size)
            .apply(MaskPoint(x: sumX / n / Double(w), y: sumY / n / Double(h)))
        XCTAssertEqual(predicted.x * Double(size.width), Double(block.midX), accuracy: 2.5)
        XCTAssertEqual(predicted.y * Double(size.height), Double(block.midY), accuracy: 2.5)
    }

    // MARK: - Weight identity under the crop affine

    func testLinearWeightIsInvariantUnderAnAspectChangingCrop() {
        assertWeightIdentity(linear, through: cropAffine(Crop(top: 0.1, left: 0.2, bottom: 0.7, right: 0.9, angle: 0)))
    }

    func testRadialWeightIsInvariantUnderAnAspectChangingCrop() {
        assertWeightIdentity(radial, through: cropAffine(Crop(top: 0.25, left: 0.05, bottom: 0.95, right: 0.5, angle: 0)))
    }

    func testLinearWeightIsInvariantUnderAStraightenedCrop() {
        assertWeightIdentity(linear, through: cropAffine(Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 12)))
    }

    func testRadialWeightIsInvariantUnderAStraightenedCrop() {
        assertWeightIdentity(radial, through: cropAffine(Crop(top: 0.15, left: 0.2, bottom: 0.85, right: 0.7, angle: -9)))
    }

    func testInvertedRadialStaysInverted() {
        let inverted = LocalMask.radial(
            center: MaskPoint(x: 0.5, y: 0.5), radii: MaskPoint(x: 0.2, y: 0.3),
            angle: 0.2, feather: 0.3, invert: true)
        assertWeightIdentity(inverted, through: cropAffine(Crop(top: 0.2, left: 0.1, bottom: 0.8, right: 0.95, angle: 4)))
    }

    func testHardEdgedMasksSurviveTheMap() {
        let hardLinear = LocalMask.linear(start: MaskPoint(x: 0.1, y: 0.1), end: MaskPoint(x: 0.9, y: 0.4), feather: 0)
        let hardRadial = LocalMask.radial(
            center: MaskPoint(x: 0.4, y: 0.6), radii: MaskPoint(x: 0.3, y: 0.3), angle: 0, feather: 0, invert: false)
        let affine = cropAffine(Crop(top: 0.05, left: 0.15, bottom: 0.95, right: 0.85, angle: 3))
        assertWeightIdentity(hardLinear, through: affine)
        assertWeightIdentity(hardRadial, through: affine)
    }

    func testAdjustmentsRangeAndEverywhereRideAlongUnchanged() {
        let adjustments = PartialAdjustments(exposure: 0.5, tint: -3)
        let affine = cropAffine(Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 0))
        let out = MaskRemap.remappedGeometry(
            [
                LocalAdjustment(mask: radial, range: .skinTone, adjustments: adjustments),
                LocalAdjustment(mask: .everywhere, range: .skinTone, adjustments: adjustments),
            ],
            through: affine)
        XCTAssertEqual(out[0].adjustments, adjustments)
        XCTAssertEqual(out[0].range, .skinTone)
        XCTAssertNotEqual(out[0].mask, radial)
        XCTAssertEqual(out[1].mask, .everywhere)
    }

    func testBitmapLayersAreLeftForTheRasterCache() {
        let recipe = BitmapRecipe(person: 0, facialSkin: true, bodySkin: true, model: "m", digest: "0123456789abcdef")
        let layer = LocalAdjustment(mask: .bitmap(recipe: recipe, rasterId: 7), adjustments: PartialAdjustments(exposure: 1))
        let out = MaskRemap.remappedGeometry(
            [layer], through: cropAffine(Crop(top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 5)))
        XCTAssertEqual(out, [layer])
    }

    // MARK: - The window affine (native detail)

    func testWindowAffineReproducesRawCoresIndexRule() {
        let affine = MaskAffine.windowToFullFrame(
            window: CGRect(x: 20, y: 10, width: 40, height: 30), fullSize: CGSize(width: 100, height: 80))
        let origin = affine.apply(MaskPoint(x: 0, y: 0))
        let far = affine.apply(MaskPoint(x: 1, y: 1))
        // Buffer pixel 0 ↔ frame pixel 20 → 20/99; buffer pixel 39 ↔ frame pixel 59 → 59/99.
        XCTAssertEqual(origin.x, 20.0 / 99.0, accuracy: 1e-12)
        XCTAssertEqual(origin.y, 10.0 / 79.0, accuracy: 1e-12)
        XCTAssertEqual(far.x, 59.0 / 99.0, accuracy: 1e-12)
        XCTAssertEqual(far.y, 39.0 / 79.0, accuracy: 1e-12)
    }

    func testWholeFrameWindowIsTheIdentity() {
        XCTAssertTrue(MaskAffine.windowToFullFrame(
            window: CGRect(x: 0, y: 0, width: 100, height: 80), fullSize: CGSize(width: 100, height: 80)).isIdentity)
        XCTAssertTrue(MaskAffine.windowToFullFrame(
            window: CGRect(x: 5, y: 5, width: 10, height: 10), fullSize: .zero).isIdentity)
    }

    func testOnePixelWindowAxisNormalisesToItsOrigin() {
        let affine = MaskAffine.windowToFullFrame(
            window: CGRect(x: 30, y: 0, width: 1, height: 50), fullSize: CGSize(width: 100, height: 50))
        XCTAssertEqual(affine.a, 0)
        XCTAssertEqual(affine.apply(MaskPoint(x: 1, y: 0.5)).x, 30.0 / 99.0, accuracy: 1e-12)
    }

    func testWeightsAreInvariantUnderTheWindowAffine() {
        let affine = MaskAffine.windowToFullFrame(
            window: CGRect(x: 700, y: 400, width: 1200, height: 900), fullSize: CGSize(width: 6000, height: 4000))
        assertWeightIdentity(linear, through: affine)
        assertWeightIdentity(radial, through: affine)
    }
}
