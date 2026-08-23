// MuiSplitLayoutMathTests — the clamp/collapse math behind the Maple.UI
// Split Layout template (Maple.WinUI/MapleUI/Templates/MuiSplitLayoutMath.cs,
// wave N5 of the Windows Maple.UI templates, #3012). No WinUI/live Window
// involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiSplitLayoutMathTests
    {
        [Theory]
        [InlineData(100.0, 200.0, 400.0, 200.0)]
        [InlineData(500.0, 200.0, 400.0, 400.0)]
        [InlineData(260.0, 200.0, 400.0, 260.0)]
        public void Clamp_BoundsValueToMinMax(double value, double min, double max, double expected)
        {
            Assert.Equal(expected, MuiSplitLayoutMath.Clamp(value, min, max));
        }

        [Fact]
        public void SidebarCollapsed_WideHost_ReturnsFalse()
        {
            Assert.False(MuiSplitLayoutMath.SidebarCollapsed(1200, collapseEnabled: true));
        }

        [Fact]
        public void SidebarCollapsed_NarrowHost_ReturnsTrue()
        {
            Assert.True(MuiSplitLayoutMath.SidebarCollapsed(500, collapseEnabled: true));
        }

        [Fact]
        public void SidebarCollapsed_ExactlyAtBreakpoint_ReturnsFalse()
        {
            // Strict "<" per mui-split-layout.component.ts — the breakpoint
            // width itself is still uncollapsed.
            Assert.False(MuiSplitLayoutMath.SidebarCollapsed(MuiSplitLayoutMath.SidebarCollapsePx, collapseEnabled: true));
        }

        [Fact]
        public void SidebarCollapsed_CollapseDisabled_AlwaysFalse()
        {
            Assert.False(MuiSplitLayoutMath.SidebarCollapsed(100, collapseEnabled: false));
        }

        [Fact]
        public void DetailCollapsed_ShowDetailFalse_AlwaysTrue()
        {
            Assert.True(MuiSplitLayoutMath.DetailCollapsed(showDetail: false, hostWidth: 2000, collapseEnabled: true));
        }

        [Fact]
        public void DetailCollapsed_NarrowHost_ReturnsTrue()
        {
            Assert.True(MuiSplitLayoutMath.DetailCollapsed(showDetail: true, hostWidth: 700, collapseEnabled: true));
        }

        [Fact]
        public void DetailCollapsed_WideHost_ReturnsFalse()
        {
            Assert.False(MuiSplitLayoutMath.DetailCollapsed(showDetail: true, hostWidth: 1200, collapseEnabled: true));
        }

        [Fact]
        public void DetailCollapsed_ExactlyAtBreakpoint_ReturnsFalse()
        {
            Assert.False(MuiSplitLayoutMath.DetailCollapsed(showDetail: true, hostWidth: MuiSplitLayoutMath.DetailCollapsePx, collapseEnabled: true));
        }

        [Fact]
        public void DetailCollapsed_CollapseDisabled_StaysFalseEvenNarrow()
        {
            Assert.False(MuiSplitLayoutMath.DetailCollapsed(showDetail: true, hostWidth: 100, collapseEnabled: false));
        }
    }
}
