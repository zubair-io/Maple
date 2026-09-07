// MaskWeight.swift — Swift port of raw-core's mask evaluator
// (`stages::local_adjustments::mask`, #355).
//
// Pure functions of `(mask, x, y)` in normalized full-frame coordinates,
// `x ∈ [0, 1]` left→right, `y ∈ [0, 1]` top→bottom. Two consumers:
//
// - `MaskRemapTests` asserts the remap identity — the remapped mask at a
//   buffer point must weigh exactly what the original weighs at the
//   corresponding full-frame point — and needs the evaluator to state it.
// - `MaskRemapRasterCache.resample` re-expresses a bitmap raster in a
//   buffer's space with the same bilinear rule raw-core's `MaskRaster
//   ::sample` reads by, so the derived raster and the original agree.
//
// Not a render path: the chain evaluates masks on the Rust side. Keep this
// in lockstep with `mask.rs` / `raster.rs`; the tests here pin the shape,
// raw-core's own tests pin the numbers.

import Foundation

public enum MaskWeight {
    /// Smoothstep `3t² − 2t³`, clamped to `[0, 1]` — `mask.rs`'s `smoothstep`.
    static func smoothstep(_ t: Double) -> Double {
        let c = min(max(t, 0), 1)
        return c * c * (3 - 2 * c)
    }

    /// The geometric weight of `mask` at normalized `(x, y)`. A `.bitmap`
    /// mask needs its raster (`sample`); this entry has none and answers 0,
    /// raw-core's own "unresolved raster" rule.
    public static func evaluate(_ mask: LocalMask, x: Double, y: Double) -> Double {
        switch mask {
        case .linear(let start, let end, let feather):
            return linear(start: start, end: end, feather: feather, x: x, y: y)
        case .radial(let center, let radii, let angle, let feather, let invert):
            let w = radial(center: center, radii: radii, angle: angle, feather: feather, x: x, y: y)
            return invert ? 1 - w : w
        case .bitmap:
            return 0
        case .everywhere:
            return 1
        }
    }

    static func linear(start: MaskPoint, end: MaskPoint, feather: Double, x: Double, y: Double) -> Double {
        let dx = end.x - start.x
        let dy = end.y - start.y
        let lenSq = dx * dx + dy * dy
        guard lenSq > Double(Float.ulpOfOne) else { return 0 }
        let t = ((x - start.x) * dx + (y - start.y) * dy) / lenSq
        let f = min(max(feather, 0), 1)
        guard f > Double(Float.ulpOfOne) else { return t < 0.5 ? 0 : 1 }
        let lo = 0.5 - f * 0.5
        let hi = 0.5 + f * 0.5
        return smoothstep((t - lo) / (hi - lo))
    }

    static func radial(
        center: MaskPoint, radii: MaskPoint, angle: Double, feather: Double, x: Double, y: Double
    ) -> Double {
        guard abs(radii.x) > Double(Float.ulpOfOne), abs(radii.y) > Double(Float.ulpOfOne) else { return 0 }
        let cosA = cos(angle)
        let sinA = sin(angle)
        let dx = x - center.x
        let dy = y - center.y
        let lx = cosA * dx + sinA * dy
        let ly = -sinA * dx + cosA * dy
        let d = ((lx / radii.x) * (lx / radii.x) + (ly / radii.y) * (ly / radii.y)).squareRoot()
        let f = min(max(feather, 0), 1)
        guard f > Double(Float.ulpOfOne) else { return d <= 1 ? 1 : 0 }
        let lo = 1 - f
        return 1 - smoothstep((d - lo) / (1 - lo))
    }

    /// Bilinear sample of an R8 raster at normalized `(x, y)`, both clamped
    /// to `[0, 1]`, mapping 0 to the first texel's centre and 1 to the last —
    /// `raster.rs`'s `MaskRaster::sample`, in `[0, 1]`. An empty raster
    /// reads as 0.
    public static func sample(
        width: Int, height: Int, bytes: [UInt8], x: Double, y: Double
    ) -> Double {
        guard width > 0, height > 0, bytes.count == width * height else { return 0 }
        let fx = min(max(x, 0), 1) * Double(max(width - 1, 0))
        let fy = min(max(y, 0), 1) * Double(max(height - 1, 0))
        let x0 = Int(fx.rounded(.down))
        let y0 = Int(fy.rounded(.down))
        let x1 = min(x0 + 1, width - 1)
        let y1 = min(y0 + 1, height - 1)
        let tx = fx - Double(x0)
        let ty = fy - Double(y0)
        let at: (Int, Int) -> Double = { px, py in Double(bytes[py * width + px]) / 255 }
        let top = at(x0, y0) * (1 - tx) + at(x1, y0) * tx
        let bottom = at(x0, y1) * (1 - tx) + at(x1, y1) * tx
        return top * (1 - ty) + bottom * ty
    }
}
