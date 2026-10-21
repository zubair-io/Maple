using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiToneCurveSplitsMathTests
    {
        [Fact]
        public void ClampSplit_EnforcesNeighborMarginsAndOuterBounds()
        {
            Assert.Equal(10, MuiToneCurveSplitsMath.ClampSplit(ParametricSplitHandle.Shadow, 2, 25, 50, 75));
            Assert.Equal(45, MuiToneCurveSplitsMath.ClampSplit(ParametricSplitHandle.Shadow, 60, 25, 50, 75));

            Assert.Equal(30, MuiToneCurveSplitsMath.ClampSplit(ParametricSplitHandle.Midtone, 20, 25, 50, 75));
            Assert.Equal(70, MuiToneCurveSplitsMath.ClampSplit(ParametricSplitHandle.Midtone, 80, 25, 50, 75));

            Assert.Equal(55, MuiToneCurveSplitsMath.ClampSplit(ParametricSplitHandle.Highlight, 40, 25, 50, 75));
            Assert.Equal(90, MuiToneCurveSplitsMath.ClampSplit(ParametricSplitHandle.Highlight, 98, 25, 50, 75));
        }

        [Fact]
        public void RegionWindows_FormNonNegativePartitionUpToHighlightsCentre()
        {
            var c = MuiToneCurveSplitsMath.RegionCentres(25, 50, 75);
            Assert.Equal(new[] { 12.5, 37.5, 62.5, 87.5 }, c);

            for (var i = 0; i <= 100; i++)
            {
                var w = MuiToneCurveSplitsMath.RegionWindows(i, 25, 50, 75);
                foreach (var weight in w)
                    Assert.True(weight >= -1e-9);
                if (i <= c[3])
                    Assert.Equal(1.0, w[0] + w[1] + w[2] + w[3], 6);
            }
        }
    }
}
