// LocalAdjustment+Flat.swift — the flat `f32` wire for a local-adjustment
// layer stack (#1698 / #355): the Swift twin of raw-core's
// `types/local_adjustment/flat.rs`, byte-for-byte.
//
// One layout serves both FFI entries the Apple shell drives —
// `MapleAdjustmentParams.local_adjustments_*` (the CPU refine chain) and
// `MapleGpuLiveParams.local_adjustments_*` (the wgpu live chain) — and the
// GPU chain binds the very same array as its `array<Layer>` storage buffer,
// which is why the stride is 24 floats (six `vec4<f32>`, 96 bytes) with
// explicit padding rather than a tight 22.
//
// Slot map (per layer, `layerLength` floats):
//
//    0..2   p0        linear: start (x, y)      radial: center (x, y)
//    2..4   p1        linear: end   (x, y)      radial: radii  (rx, ry)
//    4      feather
//    5      angle     radial only; 0 for linear
//    6      kind      0 = linear, 1 = radial
//    7      invert    radial only; 0 or 1
//    8      present   presence bitmask, bit i ⇒ slot 12 + i carries a value
//    9..12  padding (0)
//   12..16  exposure, contrast, highlights, shadows
//   16..20  whites, blacks, saturation, vibrance
//   20..22  temperature, tint
//   22..24  padding (0)
//
// Presence is a bitmask rather than a sentinel because `nil` is NOT `0` for
// four of the ten controls (saturation/vibrance at 0 still round-trip Oklab;
// temperature/tint present at all engage a CAT16 matrix) — see the Rust
// module's header. `LocalAdjustmentFlatTests` pins this layout against the
// values that module's own tests use.

import Foundation

public enum LocalAdjustmentFlat {
    /// Floats per serialized layer.
    public static let layerLength = 24

    static let kindLinear: Float = 0
    static let kindRadial: Float = 1

    /// The ten controls in slot order — bit `i` of the presence mask and
    /// slot `12 + i` both refer to `fields[i]`.
    static let fields: [KeyPath<PartialAdjustments, Double?>] = [
        \.exposure, \.contrast, \.highlights, \.shadows, \.whites,
        \.blacks, \.saturation, \.vibrance, \.temperature, \.tint,
    ]

    /// Serialize a layer stack to the flat wire. The result length is always
    /// `layers.count * layerLength`; an empty stack yields an empty array.
    ///
    /// One exactly-sized allocation (`unsafeUninitializedCapacity`), no
    /// intermediate arrays — this runs on every live render tick of a mask
    /// drag, the same budget rule `GpuLiveSession.flattened(_:)` follows for
    /// the point curves.
    public static func flatten(_ layers: [LocalAdjustment]) -> [Float] {
        guard !layers.isEmpty else { return [] }
        let count = layers.count * layerLength
        return [Float](unsafeUninitializedCapacity: count) { buffer, initialized in
            buffer.initialize(repeating: 0)
            for (index, layer) in layers.enumerated() {
                let base = index * layerLength
                writeMask(layer.mask, into: buffer, at: base)
                writeAdjustments(layer.adjustments, into: buffer, at: base)
            }
            initialized = count
        }
    }

    private static func writeMask(
        _ mask: LocalMask, into b: UnsafeMutableBufferPointer<Float>, at base: Int
    ) {
        switch mask {
        case .linear(let start, let end, let feather):
            b[base] = Float(start.x)
            b[base + 1] = Float(start.y)
            b[base + 2] = Float(end.x)
            b[base + 3] = Float(end.y)
            b[base + 4] = Float(feather)
            b[base + 6] = kindLinear
        case .radial(let center, let radii, let angle, let feather, let invert):
            b[base] = Float(center.x)
            b[base + 1] = Float(center.y)
            b[base + 2] = Float(radii.x)
            b[base + 3] = Float(radii.y)
            b[base + 4] = Float(feather)
            b[base + 5] = Float(angle)
            b[base + 6] = kindRadial
            b[base + 7] = invert ? 1 : 0
        }
    }

    private static func writeAdjustments(
        _ a: PartialAdjustments, into b: UnsafeMutableBufferPointer<Float>, at base: Int
    ) {
        let present = fields.enumerated().reduce(UInt32(0)) { acc, field in
            a[keyPath: field.element] == nil ? acc : acc | (1 << UInt32(field.offset))
        }
        // The mask never exceeds 1023 and an f32 holds every integer below
        // 2²⁴ exactly, so the float slot round-trips it losslessly.
        b[base + 8] = Float(present)
        for (i, field) in fields.enumerated() {
            b[base + 12 + i] = Float(a[keyPath: field] ?? 0)
        }
    }
}
