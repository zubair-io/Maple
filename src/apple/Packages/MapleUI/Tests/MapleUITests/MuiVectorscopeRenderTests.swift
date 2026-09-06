// MuiVectorscopeRenderTests.swift — pixel assertions for the vectorscope's
// chrome (#3350).
//
// `MuiVectorscopeMathTests` covers the geometry and the ring's colour
// function, but every one of those can pass while the Canvas draws nothing
// — a resolved symbol that silently no-ops, a stroke at the wrong radius, a
// fill the size of a pixel. The HUD renders at 96pt on screen, too small to
// eyeball, so these rasterise the real view and read the pixels back.

import SwiftUI
import XCTest

@testable import MapleUI

final class MuiVectorscopeRenderTests: XCTestCase {
    private let side: CGFloat = 240

    /// Rasterise the component at a size big enough to sample reliably.
    @MainActor
    private func render(showSkinToneLine: Bool = true) throws -> CGImage {
        let view = MuiVectorscope(
            samples: [], size: side, bins: nil,
            showSkinToneLine: showSkinToneLine, redAt3OClock: false)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 1
        return try XCTUnwrap(renderer.cgImage, "ImageRenderer produced no bitmap")
    }

    /// (r, g, b) 0...255 at a pixel.
    private func pixel(_ image: CGImage, _ x: Int, _ y: Int) throws -> (r: Int, g: Int, b: Int) {
        var buf = [UInt8](repeating: 0, count: 4)
        let ctx = try XCTUnwrap(
            CGContext(
                data: &buf, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        ctx.draw(image, in: CGRect(x: -x, y: -(image.height - 1 - y), width: image.width, height: image.height))
        return (Int(buf[0]), Int(buf[1]), Int(buf[2]))
    }

    /// Geometry helper: the pixel at `angle` (graticule degrees) and a
    /// fraction of the plot radius.
    private func point(_ image: CGImage, angleDeg: Double, atRadiusFraction f: Double) -> (Int, Int) {
        let c = Double(image.width) / 2
        let radius = Double(Swift.min(image.width, image.height)) / 2 - 4
        let rad = angleDeg * .pi / 180
        return (Int(c + cos(rad) * radius * f), Int(c - sin(rad) * radius * f))
    }

    /// The hue ring actually paints, and paints the RIGHT hue.
    ///
    /// Sampled BETWEEN targets, never at one. The six target dots are
    /// themselves drawn in their own colours at this exact radius, so a
    /// test that sampled a target's own angle would pass with the ring
    /// deleted entirely — it would be reading the dot. (It did: that was
    /// the first version of this test.) Between two targets only the ring
    /// paints, and the colour there must be a genuine blend of the two.
    @MainActor
    func testHueRingPaintsBlendedHueBetweenTargets() throws {
        let image = try render()
        let sorted = VectorscopeTarget.allCases
            .map { (t: $0, a: MuiVectorscopeMath.normalizedDeg(MuiVectorscopeMath.targetAngleDeg($0))) }
            .sorted { $0.a < $1.a }

        for i in 0..<sorted.count {
            let lo = sorted[i]
            let hi = sorted[(i + 1) % sorted.count]
            let span = MuiVectorscopeMath.normalizedDeg(hi.a - lo.a)
            let mid = MuiVectorscopeMath.normalizedDeg(lo.a + span / 2)
            let (x, y) = point(image, angleDeg: mid, atRadiusFraction: 1.0)
            let px = try pixel(image, x, y)

            // Something is painted here at all — a bare graticule would be
            // the near-black canvas.
            XCTAssertGreaterThan(
                px.r + px.g + px.b, 80,
                "no hue ring between \(lo.t) and \(hi.t): pixel \(px)")

            // And it is the blend the ring math says it should be.
            let want = MuiVectorscopeMath.ringRGB(atAngleDeg: mid)
            let got = (Double(px.r) / 255, Double(px.g) / 255, Double(px.b) / 255)
            XCTAssertEqual(got.0, want.r, accuracy: 0.20, "\(lo.t)->\(hi.t) red")
            XCTAssertEqual(got.1, want.g, accuracy: 0.20, "\(lo.t)->\(hi.t) green")
            XCTAssertEqual(got.2, want.b, accuracy: 0.20, "\(lo.t)->\(hi.t) blue")
        }
    }

    /// The skin-tone cone is filled, not just outlined: a pixel in the
    /// MIDDLE of the band (well away from both edges) is brighter than the
    /// same radius outside the band.
    @MainActor
    func testSkinToneConeIsFilled() throws {
        let image = try render(showSkinToneLine: true)
        let skin = MuiVectorscopeMath.skinToneLineAngleDeg
        let wedge = MuiVectorscopeMath.skinToneLineWedgeDeg
        // Half a wedge off-centre: inside the band, off the centre line.
        let (ix, iy) = point(image, angleDeg: skin + wedge / 2, atRadiusFraction: 0.55)
        let (ox, oy) = point(image, angleDeg: skin + wedge * 4, atRadiusFraction: 0.55)
        let inside = try pixel(image, ix, iy)
        let outside = try pixel(image, ox, oy)
        XCTAssertGreaterThan(
            inside.r + inside.g + inside.b, outside.r + outside.g + outside.b,
            "inside the skin band \(inside) must be brighter than outside it \(outside)")
    }

    /// The person glyph renders.
    ///
    /// Counts bright pixels rather than looking for a bright one, and
    /// compares against a control box further down the SAME centre line.
    /// The line is itself white at 0.75, and it runs straight through the
    /// glyph's box — so "is there a bright pixel here" passes with the
    /// glyph deleted. (It did.) A 1px line contributes a bounded handful of
    /// bright pixels; a filled glyph contributes many more.
    @MainActor
    func testPersonGlyphRenders() throws {
        let image = try render(showSkinToneLine: true)
        let skin = MuiVectorscopeMath.skinToneLineAngleDeg
        let radius = Double(Swift.min(image.width, image.height)) / 2 - 4
        let box = Swift.max(9, radius * 0.20)
        let half = Int(box / 2) + 1

        func brightCount(atRadiusFraction f: Double) throws -> Int {
            let (cx, cy) = point(image, angleDeg: skin, atRadiusFraction: f)
            var n = 0
            for dy in -half...half {
                for dx in -half...half {
                    let x = cx + dx, y = cy + dy
                    guard x >= 0, y >= 0, x < image.width, y < image.height else { continue }
                    let p = try pixel(image, x, y)
                    if Swift.min(p.r, Swift.min(p.g, p.b)) > 150 { n += 1 }
                }
            }
            return n
        }

        let glyphFraction = (radius - box * 0.75) / radius
        let atGlyph = try brightCount(atRadiusFraction: glyphFraction)
        // Half-way out: on the centre line, nowhere near the glyph.
        let lineOnly = try brightCount(atRadiusFraction: 0.5)

        XCTAssertGreaterThan(
            atGlyph, lineOnly * 2,
            "glyph box has \(atGlyph) bright pixels vs \(lineOnly) for the bare centre "
                + "line — the person marker is not drawing")
    }

    /// With the overlay off, the band is not drawn at all — the toggle has
    /// to actually gate something.
    @MainActor
    func testSkinToneOverlayIsAbsentWhenDisabled() throws {
        let image = try render(showSkinToneLine: false)
        let skin = MuiVectorscopeMath.skinToneLineAngleDeg
        let (x, y) = point(image, angleDeg: skin + MuiVectorscopeMath.skinToneLineWedgeDeg / 2,
                           atRadiusFraction: 0.55)
        let px = try pixel(image, x, y)
        XCTAssertLessThan(
            px.r + px.g + px.b, 60,
            "skin band should be absent when showSkinToneLine is false, got \(px)")
    }
}
