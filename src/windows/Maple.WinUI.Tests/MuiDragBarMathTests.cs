// MuiDragBarMathTests — the pure tick layout and value/position math behind
// the Maple.UI Drag Bar molecule (Maple.WinUI/MapleUI/Molecules/
// MuiDragBarMath.cs, wave N3a of the Windows Maple.UI molecules, #3012). No
// WinUI/live Window involved.

using System.Linq;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiDragBarMathTests
    {
        [Fact]
        public void BuildTicks_DefaultCount_Produces21EvenlySpacedTicks()
        {
            var ticks = MuiDragBarMath.BuildTicks();
            Assert.Equal(21, ticks.Count);
            Assert.Equal(0, ticks[0].Pct);
            Assert.Equal(100, ticks[^1].Pct);
            Assert.Equal(50, ticks[10].Pct, precision: 6);
        }

        [Fact]
        public void BuildTicks_CenterTickIsEmphasized_OthersAreNot()
        {
            var ticks = MuiDragBarMath.BuildTicks();
            for (var i = 0; i < ticks.Count; i++)
                Assert.Equal(i == MuiDragBarMath.DefaultCenterIndex, ticks[i].Emphasized);
        }

        [Fact]
        public void BuildTicks_CustomCount_SpacesEvenlyAndEmphasizesMiddle()
        {
            var ticks = MuiDragBarMath.BuildTicks(5);
            Assert.Equal(5, ticks.Count);
            Assert.Equal(new[] { 0, 25, 50, 75, 100 }, ticks.Select(t => (int)t.Pct).ToArray());
            Assert.True(ticks[2].Emphasized);
        }

        [Theory]
        [InlineData(0, 200, -100, 100, -100)]
        [InlineData(100, 200, -100, 100, 0)]
        [InlineData(200, 200, -100, 100, 100)]
        [InlineData(50, 200, -100, 100, -50)]
        public void ValueAtPosition_SnapsPointerXToWholeNumberValue(
            double x, double barWidth, double min, double max, double expected)
        {
            Assert.Equal(expected, MuiDragBarMath.ValueAtPosition(x, barWidth, min, max, fallback: 0));
        }

        [Fact]
        public void ValueAtPosition_ClampsBeyondTrackEnds()
        {
            Assert.Equal(100, MuiDragBarMath.ValueAtPosition(500, 200, -100, 100, fallback: 0));
            Assert.Equal(-100, MuiDragBarMath.ValueAtPosition(-500, 200, -100, 100, fallback: 0));
        }

        [Fact]
        public void ValueAtPosition_ZeroBarWidth_ReturnsFallback()
        {
            Assert.Equal(17, MuiDragBarMath.ValueAtPosition(50, 0, -100, 100, fallback: 17));
        }

        [Fact]
        public void MarkerPct_CentersAtZeroForSymmetricRange()
        {
            Assert.Equal(50, MuiDragBarMath.MarkerPct(0, -100, 100));
        }

        [Fact]
        public void MarkerPct_DegenerateRange_FallsBackToCenter()
        {
            Assert.Equal(50, MuiDragBarMath.MarkerPct(5, 10, 10));
        }
    }
}
