// LibraryGridZoom.swift — pure geometry for the iPhone Library grid's
// pinch-to-resize (Photos-style column tiers).
//
// `+VM`-style sibling of `LibraryGrid.swift`: no SwiftUI import, every
// member static and unit-tested from `MapleTests/LibraryGridZoomTests`.
//
// The grid is a `LazyVGrid` of square cells in one of a few column tiers.
// A pinch cannot re-lay a lazy grid out continuously, so while a pinch is
// live `LibraryGrid` hides the lazy grid and draws the visible slice of
// cells itself, with each cell's frame interpolated between the two tiers
// the pinch is currently between (`interpolation(baseColumns:magnification:
// width:)`). The maths here answers, for a given tier: how big a cell is,
// where cell `i` sits, and which cell is under a point — plus which pair of
// tiers a pinch is between and how far along.

import CoreGraphics
import Foundation

enum LibraryGridZoom {

    /// Column tiers the pinch snaps between, widest cells first.
    static let columnTiers: [Int] = [1, 2, 3, 5]
    /// The tier a fresh install gets (S2 spec: 3-up on phone).
    static let defaultColumns = 3
    /// Gap between cells, both axes (S2 spec: 2pt on phone).
    static let spacing: CGFloat = 2

    /// A persisted column count is only trusted if it is a tier.
    static func validatedColumns(_ stored: Int) -> Int {
        columnTiers.contains(stored) ? stored : defaultColumns
    }

    // MARK: - One tier's layout

    static func cellSize(columns: Int, width: CGFloat) -> CGFloat {
        guard columns > 0 else { return max(1, width) }
        return max(1, (width - spacing * CGFloat(columns - 1)) / CGFloat(columns))
    }

    static func rowCount(count: Int, columns: Int) -> Int {
        guard count > 0, columns > 0 else { return 0 }
        return (count + columns - 1) / columns
    }

    /// Total height the tier lays `count` cells out in — the lazy grid's own
    /// height, so anchors expressed against it match what is on screen.
    static func gridHeight(count: Int, columns: Int, width: CGFloat) -> CGFloat {
        let rows = rowCount(count: count, columns: columns)
        guard rows > 0 else { return 0 }
        return CGFloat(rows) * cellSize(columns: columns, width: width) + CGFloat(rows - 1) * spacing
    }

    /// Frame of cell `index` in grid coordinates (origin = the grid's
    /// top-leading corner).
    static func cellRect(index: Int, columns: Int, width: CGFloat) -> CGRect {
        let columns = max(1, columns)
        let size = cellSize(columns: columns, width: width)
        let row = index / columns
        let column = index % columns
        return CGRect(
            x: CGFloat(column) * (size + spacing),
            y: CGFloat(row) * (size + spacing),
            width: size,
            height: size
        )
    }

    /// The cell under `point` (grid coordinates) and where inside it the
    /// point falls (0…1 on each axis). Points in a gap or past the edges
    /// clamp to the nearest cell so a pinch that starts on a gutter still
    /// anchors on the photo beside it. `nil` only for an empty grid.
    static func focalCell(
        at point: CGPoint, columns: Int, width: CGFloat, count: Int
    ) -> (index: Int, fraction: CGPoint)? {
        guard count > 0, columns > 0 else { return nil }
        let size = cellSize(columns: columns, width: width)
        let span = size + spacing
        let column = min(columns - 1, max(0, Int((point.x / span).rounded(.down))))
        let row = min(rowCount(count: count, columns: columns) - 1, max(0, Int((point.y / span).rounded(.down))))
        let index = min(count - 1, row * columns + column)
        let rect = cellRect(index: index, columns: columns, width: width)
        let fraction = CGPoint(
            x: min(1, max(0, (point.x - rect.minX) / rect.width)),
            y: min(1, max(0, (point.y - rect.minY) / rect.height))
        )
        return (index, fraction)
    }

    /// Grid-coordinate point of `fraction` inside cell `index` in a tier.
    static func point(ofCell index: Int, fraction: CGPoint, columns: Int, width: CGFloat) -> CGPoint {
        let rect = cellRect(index: index, columns: columns, width: width)
        return CGPoint(x: rect.minX + fraction.x * rect.width, y: rect.minY + fraction.y * rect.height)
    }

    /// Indices of the cells a tier lays out anywhere inside `yRange` (grid
    /// coordinates), as a half-open range. Empty when nothing intersects.
    static func indices(intersecting yRange: ClosedRange<CGFloat>, columns: Int, width: CGFloat, count: Int) -> Range<Int> {
        guard count > 0, columns > 0 else { return 0..<0 }
        let span = cellSize(columns: columns, width: width) + spacing
        let rows = rowCount(count: count, columns: columns)
        let firstRow = min(rows - 1, max(0, Int((yRange.lowerBound / span).rounded(.down))))
        let lastRow = min(rows - 1, max(0, Int((yRange.upperBound / span).rounded(.down))))
        guard lastRow >= firstRow else { return 0..<0 }
        return (firstRow * columns)..<min(count, (lastRow + 1) * columns)
    }

    // MARK: - Where a pinch is between the tiers

    /// The two tiers a pinch is currently between and how far along it is.
    /// `magnification` is the gesture's live value against the cell size
    /// the grid had when the pinch started (`baseColumns`). `from` is the
    /// tier whose layout `progress == 0` draws and `to` the one
    /// `progress == 1` draws; `to` lies in the pinch's direction, so a pinch
    /// out walks toward fewer columns and a pinch in toward more. Past the
    /// widest or densest tier `from == to`, `progress == 0`, and the excess
    /// is reported as a damped `overscale` for a rubber-band feel.
    struct Interpolation: Equatable {
        let from: Int
        let to: Int
        let progress: CGFloat
        let overscale: CGFloat

        /// The tier a release from here should settle on.
        var settledColumns: Int { progress >= 0.5 ? to : from }
    }

    static func interpolation(baseColumns: Int, magnification: CGFloat, width: CGFloat) -> Interpolation {
        let tiers = columnTiers
        guard let baseIndex = tiers.firstIndex(of: baseColumns) else {
            return Interpolation(from: baseColumns, to: baseColumns, progress: 0, overscale: 1)
        }
        let wanted = cellSize(columns: baseColumns, width: width) * max(0.01, magnification)
        let widest = cellSize(columns: tiers[0], width: width)
        let densest = cellSize(columns: tiers[tiers.count - 1], width: width)
        if wanted >= widest {
            return Interpolation(from: tiers[0], to: tiers[0], progress: 0, overscale: rubberBand(wanted / widest))
        }
        if wanted <= densest {
            let last = tiers[tiers.count - 1]
            return Interpolation(from: last, to: last, progress: 0, overscale: 1 / rubberBand(densest / wanted))
        }
        // Walk from the base tier in the pinch's direction until `wanted`
        // lies between two neighbouring tiers' cell sizes.
        let growing = wanted >= cellSize(columns: baseColumns, width: width)
        var fromIndex = baseIndex
        while true {
            let toIndex = growing ? fromIndex - 1 : fromIndex + 1
            guard tiers.indices.contains(toIndex) else {
                return Interpolation(from: tiers[fromIndex], to: tiers[fromIndex], progress: 0, overscale: 1)
            }
            let fromSize = cellSize(columns: tiers[fromIndex], width: width)
            let toSize = cellSize(columns: tiers[toIndex], width: width)
            let progress = (wanted - fromSize) / (toSize - fromSize)
            if progress <= 1 {
                return Interpolation(from: tiers[fromIndex], to: tiers[toIndex], progress: max(0, progress), overscale: 1)
            }
            fromIndex = toIndex
        }
    }

    /// Damped growth past the end tiers: logarithmic and capped, so a pinch
    /// that keeps going gives a little (a few percent per doubling, never
    /// more than a fifth) and visibly resists rather than sailing on.
    static func rubberBand(_ ratio: CGFloat) -> CGFloat {
        1 + min(0.2, 0.08 * log(max(1, ratio)))
    }

    /// Linear blend of a cell's frame between two tiers.
    static func interpolatedRect(index: Int, from: Int, to: Int, progress: CGFloat, width: CGFloat) -> CGRect {
        let a = cellRect(index: index, columns: from, width: width)
        let b = cellRect(index: index, columns: to, width: width)
        let t = min(1, max(0, progress))
        return CGRect(
            x: a.minX + (b.minX - a.minX) * t,
            y: a.minY + (b.minY - a.minY) * t,
            width: a.width + (b.width - a.width) * t,
            height: a.height + (b.height - a.height) * t
        )
    }

    /// The nearest tier for a raw cell width — the haptic tick fires when
    /// this changes under the fingers.
    static func nearestColumns(cellWidth: CGFloat, width: CGFloat) -> Int {
        columnTiers.min { lhs, rhs in
            abs(log(cellSize(columns: lhs, width: width)) - log(max(1, cellWidth)))
                < abs(log(cellSize(columns: rhs, width: width)) - log(max(1, cellWidth)))
        } ?? defaultColumns
    }
}
