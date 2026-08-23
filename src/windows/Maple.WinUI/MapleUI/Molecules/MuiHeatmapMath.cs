using System;
using System.Collections.Generic;

namespace Maple.UI
{
    /// <summary>
    /// Plain, WinUI-free grid-cell math behind the Maple.UI Heatmap Layer
    /// data plot (unified-component-catalog.md §2.6). Same split as
    /// <see cref="MuiSliderMath"/> — linkable into Maple.WinUI.Tests without
    /// a live Window. Ports `mui-heatmap-layer.component.ts`'s cell sizing
    /// and density clamp.
    /// </summary>
    public static class MuiHeatmapMath
    {
        public static double ClampDensity(double value) => Math.Max(0, Math.Min(1, value));

        /// <summary>Column count of a jagged density grid, from its first
        /// row — 0 for an empty grid (nothing to draw).</summary>
        public static int ColumnCount(IReadOnlyList<IReadOnlyList<double>> grid) =>
            grid.Count == 0 ? 0 : grid[0].Count;

        public static double CellWidth(IReadOnlyList<IReadOnlyList<double>> grid, double width)
        {
            var cols = ColumnCount(grid);
            return cols == 0 ? 0 : width / cols;
        }

        public static double CellHeight(IReadOnlyList<IReadOnlyList<double>> grid, double height) =>
            grid.Count == 0 ? 0 : height / grid.Count;
    }
}
