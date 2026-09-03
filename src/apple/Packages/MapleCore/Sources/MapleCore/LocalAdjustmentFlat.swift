// LocalAdjustmentFlat.swift — byte-for-byte Swift mirror of
// raw_core::types::local_adjustment::flat (#3274). 32 Float32 per layer;
// the slot map is documented on that Rust file's header and MUST be kept in
// lockstep with it — a divergence here is a live-vs-fallback rendering bug,
// not a compile error.

import Foundation

public enum LocalAdjustmentFlat {
    public static let layerFloatLen = 32

    private static let kindLinear: Float = 0
    private static let kindRadial: Float = 1
    private static let kindBitmap: Float = 2
    private static let kindEverywhere: Float = 3
    private static let rangeKindColor: Float = 1

    private static let presentExposure: Int = 1 << 0
    private static let presentContrast: Int = 1 << 1
    private static let presentHighlights: Int = 1 << 2
    private static let presentShadows: Int = 1 << 3
    private static let presentWhites: Int = 1 << 4
    private static let presentBlacks: Int = 1 << 5
    private static let presentSaturation: Int = 1 << 6
    private static let presentVibrance: Int = 1 << 7
    private static let presentTemperature: Int = 1 << 8
    private static let presentTint: Int = 1 << 9
    private static let presentHue: Int = 1 << 10

    public static func toFlat(_ layers: [LocalAdjustment]) -> [Float] {
        var out = [Float](repeating: 0, count: layers.count * layerFloatLen)
        for (i, layer) in layers.enumerated() {
            let base = i * layerFloatLen
            writeMask(layer.mask, into: &out, base: base)
            writeAdjustments(layer.adjustments, into: &out, base: base)
            writeRange(layer.range, into: &out, base: base)
        }
        return out
    }

    private static func writeMask(_ mask: LocalMask, into out: inout [Float], base: Int) {
        switch mask {
        case .linear(let start, let end, let feather):
            out[base + 0] = Float(start.x)
            out[base + 1] = Float(start.y)
            out[base + 2] = Float(end.x)
            out[base + 3] = Float(end.y)
            out[base + 4] = Float(feather)
            out[base + 6] = kindLinear
        case .radial(let center, let radii, let angle, let feather, let invert):
            out[base + 0] = Float(center.x)
            out[base + 1] = Float(center.y)
            out[base + 2] = Float(radii.x)
            out[base + 3] = Float(radii.y)
            out[base + 4] = Float(feather)
            out[base + 5] = Float(angle)
            out[base + 6] = kindRadial
            out[base + 7] = invert ? 1 : 0
        case .bitmap(_, let rasterId):
            out[base + 2] = Float(rasterId)
            out[base + 6] = kindBitmap
        case .everywhere:
            out[base + 6] = kindEverywhere
        }
    }

    private static func writeAdjustments(_ a: PartialAdjustments, into out: inout [Float], base: Int) {
        let fields: [(Double?, Int)] = [
            (a.exposure, presentExposure), (a.contrast, presentContrast), (a.highlights, presentHighlights),
            (a.shadows, presentShadows), (a.whites, presentWhites), (a.blacks, presentBlacks),
            (a.saturation, presentSaturation), (a.vibrance, presentVibrance),
            (a.temperature, presentTemperature), (a.tint, presentTint),
        ]
        var present = 0
        for (value, bit) in fields where value != nil { present |= bit }
        if a.hue != nil { present |= presentHue }
        out[base + 8] = Float(present)
        for (i, (value, _)) in fields.enumerated() { out[base + 12 + i] = Float(value ?? 0) }
        out[base + 22] = Float(a.hue ?? 0)
    }

    private static func writeRange(_ range: RangeRefinement?, into out: inout [Float], base: Int) {
        guard case let .color(hueDeg, halfWidth, chromaMin, lMin, lMax, feather) = range else { return }
        out[base + 24] = rangeKindColor
        out[base + 25] = Float(hueDeg)
        out[base + 26] = Float(halfWidth)
        out[base + 27] = Float(chromaMin)
        out[base + 28] = Float(lMin)
        out[base + 29] = Float(lMax)
        out[base + 30] = Float(feather)
    }

    /// `rasterDigests` maps a resolved raster id (slot 2 of a bitmap record)
    /// to its digest, so a decoded `LocalMask.bitmap`'s recipe carries the right
    /// identity even though the flat wire itself only stores the id.
    public static func fromFlat(_ flat: [Float], rasterDigests: [UInt32: String]) -> [LocalAdjustment] {
        stride(from: 0, to: flat.count - flat.count % layerFloatLen, by: layerFloatLen).map { base in
            LocalAdjustment(
                mask: readMask(flat, base: base, rasterDigests: rasterDigests),
                range: readRange(flat, base: base),
                adjustments: readAdjustments(flat, base: base)
            )
        }
    }

    private static func readMask(_ flat: [Float], base: Int, rasterDigests: [UInt32: String]) -> LocalMask {
        let kind = flat[base + 6]
        if kind == kindEverywhere { return .everywhere }
        if kind == kindBitmap {
            let rasterId = UInt32(flat[base + 2])
            let digest = rasterDigests[rasterId] ?? ""
            return .bitmap(
                recipe: BitmapRecipe(person: 0, facialSkin: true, bodySkin: true, model: "", digest: digest),
                rasterId: rasterId
            )
        }
        if kind == kindRadial {
            return .radial(
                center: MaskPoint(x: Double(flat[base + 0]), y: Double(flat[base + 1])),
                radii: MaskPoint(x: Double(flat[base + 2]), y: Double(flat[base + 3])),
                angle: Double(flat[base + 5]), feather: Double(flat[base + 4]), invert: flat[base + 7] != 0
            )
        }
        return .linear(
            start: MaskPoint(x: Double(flat[base + 0]), y: Double(flat[base + 1])),
            end: MaskPoint(x: Double(flat[base + 2]), y: Double(flat[base + 3])), feather: Double(flat[base + 4])
        )
    }

    private static func readAdjustments(_ flat: [Float], base: Int) -> PartialAdjustments {
        let present = Int(flat[base + 8])
        func field(_ i: Int, _ bit: Int) -> Double? { present & bit != 0 ? Double(flat[base + 12 + i]) : nil }
        return PartialAdjustments(
            exposure: field(0, presentExposure), contrast: field(1, presentContrast),
            highlights: field(2, presentHighlights),
            shadows: field(3, presentShadows), whites: field(4, presentWhites), blacks: field(5, presentBlacks),
            saturation: field(6, presentSaturation), vibrance: field(7, presentVibrance),
            temperature: field(8, presentTemperature), tint: field(9, presentTint),
            hue: present & presentHue != 0 ? Double(flat[base + 22]) : nil
        )
    }

    private static func readRange(_ flat: [Float], base: Int) -> RangeRefinement? {
        guard flat[base + 24] == rangeKindColor else { return nil }
        return .color(
            hueDeg: Double(flat[base + 25]), hueHalfWidthDeg: Double(flat[base + 26]),
            chromaMin: Double(flat[base + 27]),
            lMin: Double(flat[base + 28]), lMax: Double(flat[base + 29]), feather: Double(flat[base + 30])
        )
    }
}
