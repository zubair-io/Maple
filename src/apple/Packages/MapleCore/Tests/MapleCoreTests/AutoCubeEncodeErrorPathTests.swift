// AutoCubeEncodeErrorPathTests.swift — #877 error-path invariant.
//
// The gamut-correct sRGB display encode (`encodeDisplayViaFFI`) and the
// sRGB-tagged Auto Profile cube MUST travel together. The original #871/#877
// blowout was a color-space mismatch: an sRGB-tagged cube applied to a
// Rec.2020-tagged buffer. The encode's error path could reintroduce exactly
// that — falling back to the un-encoded Rec.2020 image while STILL applying
// the sRGB cube.
//
// `ImageEditPipeline.applyAutoCubeIfEncoded` is the pure seam that enforces the
// invariant: when the encode failed (`encoded == nil`) it drops to the
// cube-less Rec.2020 fallback (Neutral). This file locks that without forcing
// an FFI failure (impossible from a pixel test) by exercising the seam directly.
//
// Fixture-free — runs everywhere (no `test-fixtures/raws` dependency).

import CoreImage
import RawPipeline
import XCTest
@testable import MapleCore

final class AutoCubeEncodeErrorPathTests: XCTestCase {

    private static let curveFlatLen = 220  // PROFILE_CURVE_FLAT_LEN

    /// A synthetic brightening Auto curve (`out = in^0.7` per channel), identity
    /// matrix / zero corrections. Non-identity, so a wrongly-applied cube
    /// visibly shifts pixels.
    private func brighteningCurveFlat() -> [Float] {
        var flat = [Float]()
        flat.reserveCapacity(Self.curveFlatLen)
        for _ in 0..<3 {
            for i in 0..<32 {
                let inp = Float(i) / 31.0
                flat.append(inp)
                flat.append(pow(inp, 0.7))
            }
        }
        flat.append(contentsOf: [1, 0, 0, 0, 1, 0, 0, 0, 1])  // identity matrix
        flat.append(1.0)                                       // chroma_boost
        flat.append(contentsOf: [0, 0])                        // chroma_offset
        flat.append(0.0)                                       // lightness_offset
        flat.append(contentsOf: [0, 0, 0, 0, 0])               // lightness_band
        flat.append(contentsOf: [Float](repeating: 0, count: 10))
        precondition(flat.count == Self.curveFlatLen)
        return flat
    }

    /// Render a 1×1 CIImage to sRGB u8 through a fixed CIContext.
    private func renderSRGBu8(_ image: CIImage) -> [Int] {
        let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CIContext(options: [.workingColorSpace: srgb])
        var px = [UInt8](repeating: 0, count: 4)
        px.withUnsafeMutableBytes { buf in
            ctx.render(image, toBitmap: buf.baseAddress!, rowBytes: 4,
                       bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
                       format: .RGBA8, colorSpace: srgb)
        }
        return [Int(px[0]), Int(px[1]), Int(px[2])]
    }

    /// COMMITTED GATE: when the encode FAILS (`encoded == nil`),
    /// `applyAutoCubeIfEncoded` must NOT apply the sRGB cube to the un-encoded
    /// Rec.2020 `fallback`. The encode + cube travel together.
    func testAutoCubeNotAppliedWhenEncodeFails877() throws {
        // A non-identity Auto cube — if wrongly applied to the fallback, the
        // rendered pixels would shift.
        let cube = AutoProfileLUT.buildFilterFromCurve(brighteningCurveFlat())
        XCTAssertNotNil(cube, "brightening cube must build")

        // Fallback = the un-encoded, still-Rec.2020-tagged display-linear buffer
        // (a saturated wide-gamut green — the #877 class).
        let rec2020 = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        let fb: [Float] = [0.0, 0.8, 0.0, 1.0]
        let fallback = fb.withUnsafeBytes { raw -> CIImage in
            CIImage(bitmapData: Data(raw), bytesPerRow: 16,
                    size: CGSize(width: 1, height: 1),
                    format: .RGBAf, colorSpace: rec2020)
        }

        // (a) Encode FAILED (nil): result must be byte-identical to rendering
        //     the bare fallback — i.e. the cube was NOT applied.
        let onFailure = ImageEditPipeline.applyAutoCubeIfEncoded(
            encoded: nil, fallback: fallback, profileLUT: cube
        )
        let failurePx = renderSRGBu8(onFailure)
        let bareFallbackPx = renderSRGBu8(fallback)
        XCTAssertEqual(
            failurePx, bareFallbackPx,
            "encode-failed path applied the cube (or altered the fallback): " +
            "got \(failurePx) expected bare-fallback \(bareFallbackPx)"
        )

        // (b) Sanity that the cube is genuinely non-identity in this domain —
        //     applied to a real encoded sRGB image it MUST shift pixels, so the
        //     equality in (a) is meaningful (not a vacuous no-op cube).
        let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
        let encodedBytes = try PipelineRenderer.encodeDisplaySRGB(
            inputBytes: fb.withUnsafeBytes { Data($0) }, width: 1, height: 1
        )
        let encoded = encodedBytes.withUnsafeBytes { raw -> CIImage in
            CIImage(bitmapData: Data(raw), bytesPerRow: 16,
                    size: CGSize(width: 1, height: 1),
                    format: .RGBAf, colorSpace: srgb)
        }
        let withCube = ImageEditPipeline.applyAutoCubeIfEncoded(
            encoded: encoded, fallback: fallback, profileLUT: cube
        )
        let noCube = ImageEditPipeline.applyAutoCubeIfEncoded(
            encoded: encoded, fallback: fallback, profileLUT: nil
        )
        XCTAssertNotEqual(
            renderSRGBu8(withCube), renderSRGBu8(noCube),
            "the cube must be non-identity on a real encoded image — otherwise (a) is vacuous"
        )
    }
}
