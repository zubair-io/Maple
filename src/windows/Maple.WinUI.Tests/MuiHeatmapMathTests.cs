// MuiHeatmapMathTests — the pure grid-cell math behind the Maple.UI
// Heatmap Layer data plot (Maple.WinUI/MapleUI/Molecules/MuiHeatmapMath.cs,
// wave N3b of the Windows Maple.UI molecules, #3012). No WinUI/live Window
// involved.

using System.Collections.Generic;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiHeatmapMathTests
    {
        private static readonly List<IReadOnlyList<double>> Grid = new()
        {
            new List<double> { 0.1, 0.2, 0.3, 0.4 },
            new List<double> { 0.5, 0.6, 0.7, 0.8 },
        };

        [Fact]
        public void ColumnCount_UsesFirstRowLength()
        {
            Assert.Equal(4, MuiHeatmapMath.ColumnCount(Grid));
        }

        [Fact]
        public void ColumnCount_EmptyGrid_IsZero()
        {
            Assert.Equal(0, MuiHeatmapMath.ColumnCount(new List<IReadOnlyList<double>>()));
        }

        [Fact]
        public void CellWidth_DividesWidthByColumnCount()
        {
            Assert.Equal(40, MuiHeatmapMath.CellWidth(Grid, 160));
        }

        [Fact]
        public void CellWidth_EmptyGrid_IsZero()
        {
            Assert.Equal(0, MuiHeatmapMath.CellWidth(new List<IReadOnlyList<double>>(), 160));
        }

        [Fact]
        public void CellHeight_DividesHeightByRowCount()
        {
            Assert.Equal(48, MuiHeatmapMath.CellHeight(Grid, 96));
        }

        [Fact]
        public void CellHeight_EmptyGrid_IsZero()
        {
            Assert.Equal(0, MuiHeatmapMath.CellHeight(new List<IReadOnlyList<double>>(), 96));
        }

        [Theory]
        [InlineData(-0.2, 0)]
        [InlineData(1.4, 1)]
        [InlineData(0.6, 0.6)]
        public void ClampDensity_BoundsIntoZeroToOne(double value, double expected)
        {
            Assert.Equal(expected, MuiHeatmapMath.ClampDensity(value));
        }
    }
}
