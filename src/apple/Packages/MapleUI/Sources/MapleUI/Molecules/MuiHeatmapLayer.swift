// MuiHeatmapLayer.swift — Maple UI Molecules-L1 (unified-component-
// catalog.md §2.6; a plot primitive). A density grid rendered as an
// alpha-blended overlay via SwiftUI `Canvas` (e.g. a face-detection
// density map synced to a map/photo viewport elsewhere in the app — the
// camera-sync itself is the host's concern; this component only rasterizes
// the grid it's given). Cell color reads the accent token, alpha-blended
// per cell by that cell's normalized density.

import SwiftUI

public struct MuiHeatmapLayer: View {
    /// Rows of per-cell density, each `0...1`. Every row must be the same
    /// length; an empty grid draws nothing.
    public let grid: [[Double]]
    public let width: CGFloat
    public let height: CGFloat
    public let color: Color

    public init(grid: [[Double]], width: CGFloat = 160, height: CGFloat = 96, color: Color = MuiTokens.primary) {
        self.grid = grid
        self.width = width
        self.height = height
        self.color = color
    }

    public var body: some View {
        Canvas { context, size in
            guard let firstRow = grid.first, !firstRow.isEmpty else { return }
            let cols = firstRow.count
            let cellW = size.width / CGFloat(cols)
            let cellH = size.height / CGFloat(grid.count)

            for (rowIndex, row) in grid.enumerated() {
                for (colIndex, value) in row.enumerated() {
                    let density = MuiCurvePlotMath.clampUnit(value)
                    guard density > 0 else { continue }
                    let rect = CGRect(x: CGFloat(colIndex) * cellW, y: CGFloat(rowIndex) * cellH, width: cellW, height: cellH)
                    context.fill(Path(rect), with: .color(color.opacity(density)))
                }
            }
        }
        .frame(width: width, height: height)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Heatmap layer")
    }
}

#Preview("MuiHeatmapLayer") {
    let grid: [[Double]] = (0..<8).map { row -> [Double] in
        (0..<8).map { col -> Double in
            let distance: Double = Double(abs(row - 4) + abs(col - 4))
            return Swift.max(0, 1 - distance / 6.0)
        }
    }
    return MuiHeatmapLayer(grid: grid)
        .padding()
        .background(MuiTokens.imageCanvas)
}
