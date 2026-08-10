// FilmLookCube.swift — bakes a resolved film-look lattice into a
// `CIColorCubeWithColorSpace` filter for the CPU/CIImage render chain
// (epic #2683, closing the #2713 CPU-fallback gap for the interactive
// canvas).
//
// `raw-core`'s `film_look::apply` (raw-pipeline/raw-core/src/stages/
// film_look.rs) runs on `DisplayLinearRec2020`: it converts each pixel to
// linear sRGB, gamma-encodes into the lattice's own domain, tetrahedrally
// samples the baked `.mlut`, decodes back to linear sRGB, converts back to
// Rec.2020, and blends the ORIGINAL (linear) pixel toward that result by
// `strength / 100`.
//
// `EditSession+Render.swift`'s CPU fallback chain
// (`ImageEditPipeline.processSceneLinear`) does not have that stage
// available to it — the FFI struct it drives has no film-look field
// (#2713) — but its OUTPUT is already the final display-encoded sRGB
// `CIImage` (`encodeDisplaySRGBViaFFI`'s result), which is exactly the
// domain a `.mlut` lattice is baked in. That means the lattice can be
// applied directly as a Core Image color cube on that output, without
// reimplementing raw-core's Rec.2020⇄sRGB round-trip in Swift — trading
// raw-core's LINEAR-domain strength blend for one baked into the CUBE
// DATA itself (`identity.lerp(film, strength/100)` per node, in the
// gamma-encoded domain). Core Image's own tri-linear cube interpolation
// (vs. raw-core's tetrahedral `tetra_sample`) and the linear-vs-encoded
// blend domain both introduce a small, bounded divergence from the
// reference — acceptable for this interactive display path; the export
// path (`EditSession+FilmExport.swift`) stays bit-exact via
// `maple_render_file_with_film`.
//
// Cost: baking a 33-node cube is a ~36k-iteration scalar loop (well under
// 1ms) — cheap enough to rebuild on every render tick with no caching.

import CoreImage
import Foundation

enum FilmLookCube {
    /// Apply `lattice` to `image`, blended toward identity by
    /// `strengthPct` (0...100). Returns `image` unchanged when there is no
    /// lattice, `strengthPct <= 0` (matching raw-core's identity
    /// short-circuit), or the cube filter can't be built — a missing/inert
    /// look must never fail a render.
    static func apply(
        to image: CIImage,
        lattice: (data: [Float], size: Int, key: UInt32)?,
        strengthPct: Double
    ) -> CIImage {
        guard let lattice, strengthPct > 0,
              let filter = colorCubeFilter(size: lattice.size, film: lattice.data, strengthPct: strengthPct)
        else { return image }
        filter.setValue(image, forKey: kCIInputImageKey)
        return filter.outputImage ?? image
    }

    /// Builds the `CIColorCubeWithColorSpace` filter for one (lattice,
    /// strength) pair. `nil` on a malformed lattice (wrong element count
    /// for `size`, or `size <= 1` — degenerate, no interpolation possible).
    static func colorCubeFilter(size: Int, film: [Float], strengthPct: Double) -> CIFilter? {
        let n = size
        guard n > 1, film.count == n * n * n * 3 else { return nil }
        let t = Float(min(max(strengthPct / 100.0, 0.0), 1.0))
        let denom = Float(n - 1)

        // RGBA float table, node order `((b*n+g)*n+r)*4+component` —
        // matches `film.count`'s `*3` source layout (`maple_film_lut_decode`'s
        // documented ordering, same as `FilmLutStore`) with an appended
        // alpha=1 per node, which is what `CIColorCubeWithColorSpace` expects.
        var rgba = [Float](repeating: 0, count: n * n * n * 4)
        var srcIndex = 0
        var dstIndex = 0
        for b in 0..<n {
            let bf = Float(b) / denom
            for g in 0..<n {
                let gf = Float(g) / denom
                for r in 0..<n {
                    let rf = Float(r) / denom
                    rgba[dstIndex] = rf + (film[srcIndex] - rf) * t
                    rgba[dstIndex + 1] = gf + (film[srcIndex + 1] - gf) * t
                    rgba[dstIndex + 2] = bf + (film[srcIndex + 2] - bf) * t
                    rgba[dstIndex + 3] = 1
                    srcIndex += 3
                    dstIndex += 4
                }
            }
        }

        guard let filter = CIFilter(name: "CIColorCubeWithColorSpace"),
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)
        else { return nil }
        let data = rgba.withUnsafeBufferPointer { Data(buffer: $0) }
        filter.setValue(n, forKey: "inputCubeDimension")
        filter.setValue(data, forKey: "inputCubeData")
        filter.setValue(colorSpace, forKey: "inputColorSpace")
        return filter
    }
}
