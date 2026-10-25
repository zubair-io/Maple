using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiToneCurveSplitsMathTests
    {
        [Theory]
        [InlineData(ParametricSplitHandle.Shadow, 24.5, 25)]
        [InlineData(ParametricSplitHandle.Midtone, 50.5, 51)]
        [InlineData(ParametricSplitHandle.Highlight, 74.5, 75)]
        public void MidpointsMatchWebAndApple(ParametricSplitHandle handle, double proposed, double expected)
        {
            Assert.Equal(expected, MuiToneCurveSplitsMath.ClampSplit(handle, proposed, 25, 50, 75));
        }

        [Fact]
        public void SplitPlotGeometryUsesTheLogAxisInBothDirections()
        {
            Assert.Equal(0.045, MuiToneCurveSplitsMath.AuthoringX(50), 9);
            foreach (var axis in new[] { 10.0, 25, 50, 75, 90 })
                Assert.Equal(axis, MuiToneCurveSplitsMath.Axis(MuiToneCurveSplitsMath.AuthoringX(axis)), 9);
        }

        [Fact]
        public void ImportedNeighborsCannotRaiseTheInteractiveUpperBound()
        {
            Assert.Equal(90, MuiToneCurveSplitsMath.ClampSplit(ParametricSplitHandle.Highlight, 50, 97, 98, 99));
            Assert.Equal(80, MuiToneCurveSplitsMath.ClampSplit(ParametricSplitHandle.Midtone, 50, 97, 98, 99));
        }

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
