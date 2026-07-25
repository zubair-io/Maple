// ToneCurve.swift — user-authored point curve for `AdjustmentModel`.
//
// Swift mirror of `raw_core::types::ToneCurve` (#273 slice 1). The four
// `toneCurve*` FIELDS on `AdjustmentModel` are codegen'd from
// `ADJUSTMENT_SCHEMA` (the `FieldName` cases in
// `Generated/AdjustmentModel+Generated.swift`, #366); this value type is
// hand-written, exactly like `Crop` — a nested value is not something the
// flat schema table can describe.
//
// XMP read/write for the curves lands in #365 and the curve editor in
// #367; both consume this type, so its shape is deliberately minimal and
// stable.

import Foundation

// MARK: - ToneCurvePoint

/// A single control point on a `ToneCurve`. `(x, y)` lives in the curve
/// editor's `[0, 1]` × `[0, 1]` authoring domain regardless of which curve
/// carries it — the render stage owns the authoring-to-scene-linear
/// mapping. A tuple (not a struct) to mirror `raw_core`'s
/// `ToneCurvePoint = (f32, f32)`.
public typealias ToneCurvePoint = (x: Double, y: Double)

// MARK: - ToneCurve

/// A user-authored point curve. Control points are sorted by `x` at use
/// time — neither this type nor the raw-core original assumes input order.
///
/// **The empty curve is identity.** `ToneCurve()` / `ToneCurve.identity`
/// short-circuits the evaluator to a pass-through, which is what keeps a
/// default `AdjustmentModel` bit-identical to the pre-tone-curve pipeline
/// output on every platform.
///
/// `Codable` here is the JSON surface (caches, preset/exports), not the XMP
/// wire format: points encode as `[[x, y], …]`, matching the TypeScript
/// mirror's `ToneCurvePoint = [number, number]`. The `[0, 255]` PV2012 XMP
/// encoding is applied at the sidecar boundary (#365), never on this type.
public struct ToneCurve: Codable, Sendable, Equatable, Hashable {
    /// Control points `(x, y)` in `[0, 1]` × `[0, 1]`. May be empty — empty
    /// means identity / pass-through and is the canonical default.
    public var points: [ToneCurvePoint]

    public init(points: [ToneCurvePoint] = []) {
        self.points = points
    }

    /// Identity (pass-through) curve.
    public static let identity = ToneCurve()

    /// True when the curve is the identity / pass-through curve.
    public var isIdentity: Bool {
        points.isEmpty
    }

    // MARK: Equatable / Hashable
    //
    // Tuples cannot conform to protocols in Swift, so `[ToneCurvePoint]`
    // blocks the synthesised conformances `AdjustmentModel` needs.

    public static func == (lhs: ToneCurve, rhs: ToneCurve) -> Bool {
        lhs.points.count == rhs.points.count
            && zip(lhs.points, rhs.points).allSatisfy { $0.x == $1.x && $0.y == $1.y }
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(points.count)
        for point in points {
            hasher.combine(point.x)
            hasher.combine(point.y)
        }
    }

    // MARK: Codable

    private enum CodingKeys: String, CodingKey {
        case points
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let pairs = try container.decodeIfPresent([[Double]].self, forKey: .points) ?? []
        self.points = try pairs.map { pair in
            guard pair.count == 2 else {
                throw DecodingError.dataCorruptedError(
                    forKey: .points,
                    in: container,
                    debugDescription:
                        "tone-curve control point must be an [x, y] pair, got \(pair.count) value(s)"
                )
            }
            return (x: pair[0], y: pair[1])
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(points.map { [$0.x, $0.y] }, forKey: .points)
    }
}
