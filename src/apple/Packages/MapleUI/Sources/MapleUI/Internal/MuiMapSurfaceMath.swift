// MuiMapSurfaceMath.swift — pure clustering + density math for
// `MuiMapSurface`. Ported from the web reference's `groupByDistance`/
// `toClusterPin`/heatmap-grid builder (mui-map-surface.component.ts): a
// greedy distance-threshold walk over the positioned annotations (simple
// and deterministic given a stable input order — not a proper spatial
// index, which this reference surface doesn't need) plus a fixed-size
// density grid for the heatmap overlay.

import CoreGraphics
import Foundation

public struct MuiMapPositionedAnnotation: Identifiable, Sendable {
    public let id: String
    public let normalizedX: Double
    public let normalizedY: Double
    public let label: String?
    public let thumbnailUrl: URL?
    public let screenX: CGFloat
    public let screenY: CGFloat

    public init(id: String, normalizedX: Double, normalizedY: Double, label: String?, thumbnailUrl: URL?, screenX: CGFloat, screenY: CGFloat) {
        self.id = id
        self.normalizedX = normalizedX
        self.normalizedY = normalizedY
        self.label = label
        self.thumbnailUrl = thumbnailUrl
        self.screenX = screenX
        self.screenY = screenY
    }
}

public struct MuiMapPin: Identifiable, Sendable {
    public let id: String
    public let screenX: CGFloat
    public let screenY: CGFloat
    public let label: String?
    public let thumbnailUrl: URL?
    /// Non-nil (and > 1) only once this pin represents a merged cluster.
    public let count: Int?
    public let memberIds: [String]
}

enum MuiMapSurfaceMath {
    static let heatmapRows = 8
    static let heatmapCols = 8

    /// Greedy distance-threshold grouping: walk the positioned annotations
    /// in order, folding every not-yet-claimed annotation within
    /// `threshold` points of the current anchor into its cluster.
    static func groupByDistance(_ positioned: [MuiMapPositionedAnnotation], threshold: CGFloat) -> [[MuiMapPositionedAnnotation]] {
        var claimed = Set<String>()
        var groups: [[MuiMapPositionedAnnotation]] = []

        for anchor in positioned {
            guard !claimed.contains(anchor.id) else { continue }
            var group = [anchor]
            claimed.insert(anchor.id)

            for candidate in positioned {
                guard !claimed.contains(candidate.id) else { continue }
                let dx = anchor.screenX - candidate.screenX
                let dy = anchor.screenY - candidate.screenY
                if (dx * dx + dy * dy).squareRoot() <= threshold {
                    group.append(candidate)
                    claimed.insert(candidate.id)
                }
            }
            groups.append(group)
        }
        return groups
    }

    /// Reduces one cluster group to its rendered pin: the group's
    /// screen-space centroid, plus a single member's label/thumbnail only
    /// when the group wasn't merged with anything else.
    static func toClusterPin(_ group: [MuiMapPositionedAnnotation]) -> MuiMapPin {
        let anchor = group[0]
        let screenX = group.reduce(0) { $0 + $1.screenX } / CGFloat(group.count)
        let screenY = group.reduce(0) { $0 + $1.screenY } / CGFloat(group.count)
        let merged = group.count > 1
        return MuiMapPin(
            id: anchor.id,
            screenX: screenX,
            screenY: screenY,
            label: merged ? nil : anchor.label,
            thumbnailUrl: merged ? nil : anchor.thumbnailUrl,
            count: merged ? group.count : nil,
            memberIds: group.map(\.id)
        )
    }

    /// Density grid for the heatmap overlay, built from raw normalized
    /// (0...1) coordinates — not pan-adjusted screen space, since the
    /// heatmap represents the underlying data's density, not the current
    /// viewport.
    static func heatmapGrid(normalizedPoints: [(x: Double, y: Double)]) -> [[Double]] {
        var grid = Array(repeating: Array(repeating: 0.0, count: heatmapCols), count: heatmapRows)
        for point in normalizedPoints {
            let col = min(heatmapCols - 1, max(0, Int(point.x * Double(heatmapCols))))
            let row = min(heatmapRows - 1, max(0, Int(point.y * Double(heatmapRows))))
            grid[row][col] += 1
        }
        let maxValue = max(1.0, grid.flatMap { $0 }.max() ?? 1.0)
        return grid.map { row in row.map { $0 / maxValue } }
    }
}
