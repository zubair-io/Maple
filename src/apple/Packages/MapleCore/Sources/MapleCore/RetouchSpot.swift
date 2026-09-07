// RetouchSpot.swift — hand-written Swift mirror of
// `raw_core::types::retouch` (#3409), the clone / heal repair spot list.
//
// Permanently outside codegen for the same reason `LocalAdjustment.swift`
// is: a nested list has no `ADJUSTMENT_SCHEMA` entry to generate from. Keep
// this file in lockstep with the Rust module — a divergence here is a
// silent rendering difference, not a compile error.

import Foundation

/// How a spot's source pixels combine with its destination.
public enum RetouchKind: String, Codable, Sendable, Equatable, Hashable, CaseIterable {
    /// Source detail on destination colour — a Gaussian low/high split.
    case heal
    /// Straight copy of the source patch.
    case clone

    /// The Adobe `crs:SpotType` wire spelling.
    public var wire: String { rawValue }

    /// Parse a `crs:SpotType` value; nil for a kind this build does not model.
    public static func fromWire(_ raw: String) -> RetouchKind? { RetouchKind(rawValue: raw) }
}

/// A point in normalised image coordinates, `[0, 1]`, origin top-left — the
/// same convention `MaskPoint` and `Crop` use.
public struct RetouchPoint: Codable, Sendable, Equatable, Hashable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// One repair spot. The list applies front to back, so a later spot can
/// source from an earlier spot's result.
///
/// `radius` is a fraction of the image WIDTH and the disc is a circle in
/// PIXEL space — unlike a mask, whose "circular" radial shape is an ellipse
/// on a non-square frame. A clone patch copied through an elliptical stencil
/// would not be the shape the user drew.
///
/// `feather` is a fraction of `radius` (0 = hard edge, 1 = the whole disc is
/// transition) and `opacity` scales the composite. Both are `[0, 1]`.
public struct RetouchSpot: Codable, Sendable, Equatable, Hashable, Identifiable {
    /// SwiftUI list identity ONLY — deliberately outside `==` / `hash` and
    /// with no Rust counterpart, the same rule `LocalAdjustment.id` follows.
    public let id: UUID
    public var kind: RetouchKind
    /// Destination disc centre.
    public var center: RetouchPoint
    /// Source disc centre.
    public var source: RetouchPoint
    public var radius: Double
    public var feather: Double
    public var opacity: Double

    /// 2 % of the frame width — Lightroom's own default spot on import.
    public static let defaultRadius: Double = 0.02
    /// Half the radius.
    public static let defaultFeather: Double = 0.5

    public init(
        id: UUID = UUID(),
        kind: RetouchKind,
        center: RetouchPoint,
        source: RetouchPoint,
        radius: Double = RetouchSpot.defaultRadius,
        feather: Double = RetouchSpot.defaultFeather,
        opacity: Double = 1
    ) {
        self.id = id
        self.kind = kind
        self.center = center
        self.source = source
        self.radius = radius
        self.feather = feather
        self.opacity = opacity
    }

    /// Mirrors `RetouchSpot::is_effective`: whether this spot can change a
    /// pixel. A degenerate spot renders as nothing.
    public var isEffective: Bool {
        let values = [center.x, center.y, source.x, source.y, radius, feather, opacity]
        let finite = values.allSatisfy { $0.isFinite }
        let moved = source.x != center.x || source.y != center.y
        return finite && radius > 0 && opacity > 0 && moved
    }

    // `id` is decoded leniently so a sidecar or pasteboard payload written by
    // another platform (neither of which carries one) still decodes.
    private enum CodingKeys: String, CodingKey {
        case id, kind, center, source, radius, feather, opacity
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        self.kind = try c.decode(RetouchKind.self, forKey: .kind)
        self.center = try c.decode(RetouchPoint.self, forKey: .center)
        self.source = try c.decode(RetouchPoint.self, forKey: .source)
        self.radius = try c.decode(Double.self, forKey: .radius)
        self.feather = try c.decode(Double.self, forKey: .feather)
        self.opacity = try c.decode(Double.self, forKey: .opacity)
    }

    public static func == (lhs: RetouchSpot, rhs: RetouchSpot) -> Bool {
        lhs.kind == rhs.kind
            && lhs.center == rhs.center
            && lhs.source == rhs.source
            && lhs.radius == rhs.radius
            && lhs.feather == rhs.feather
            && lhs.opacity == rhs.opacity
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(kind)
        hasher.combine(center)
        hasher.combine(source)
        hasher.combine(radius)
        hasher.combine(feather)
        hasher.combine(opacity)
    }
}
