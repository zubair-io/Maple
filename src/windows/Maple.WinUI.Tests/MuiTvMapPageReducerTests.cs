// MuiTvMapPageReducerTests — the pin-count heatmap gate behind the
// Maple.UI TV Map page (Windows Pages wave, #3012). No WinUI/live Window
// involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiTvMapPageReducerTests
    {
        [Fact]
        public void ShouldShowHeatmap_BelowThreshold_ReturnsFalse()
        {
            Assert.False(MuiTvMapPageReducer.ShouldShowHeatmap(MuiTvMapPageReducer.HeatmapThreshold - 1));
        }

        [Fact]
        public void ShouldShowHeatmap_AtThreshold_ReturnsTrue()
        {
            Assert.True(MuiTvMapPageReducer.ShouldShowHeatmap(MuiTvMapPageReducer.HeatmapThreshold));
        }

        [Fact]
        public void ShouldShowHeatmap_AboveThreshold_ReturnsTrue()
        {
            Assert.True(MuiTvMapPageReducer.ShouldShowHeatmap(MuiTvMapPageReducer.HeatmapThreshold + 5));
        }

        [Fact]
        public void ShouldShowHeatmap_Zero_ReturnsFalse()
        {
            Assert.False(MuiTvMapPageReducer.ShouldShowHeatmap(0));
        }
    }
}
