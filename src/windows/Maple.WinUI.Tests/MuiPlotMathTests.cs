// MuiPlotMathTests — the pure bar-height/lane-layout math shared by the
// Maple.UI Histogram, Waveform, and Parade data plots
// (Maple.WinUI/MapleUI/Molecules/MuiPlotMath.cs, wave N3b of the Windows
// Maple.UI molecules, #3012). No WinUI/live Window involved. Covers the
// Histogram peak-relative binning specifically (Peak/BarHeightFraction).

using System.Collections.Generic;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiPlotMathTests
    {
        [Fact]
        public void Peak_ReturnsTallestSampleAcrossAllChannels()
        {
            var channels = new List<IReadOnlyList<double>>
            {
                new List<double> { 1, 5, 3 },
                new List<double> { 2, 8, 1 },
            };
            Assert.Equal(8, MuiPlotMath.Peak(channels));
        }

        [Fact]
        public void Peak_EmptyChannels_FloorsAtOne()
        {
            Assert.Equal(1, MuiPlotMath.Peak(System.Array.Empty<IReadOnlyList<double>>()));
        }

        [Fact]
        public void Peak_AllSamplesBelowOne_FloorsAtOne()
        {
            var channels = new List<IReadOnlyList<double>> { new List<double> { 0.2, 0.5, 0.1 } };
            Assert.Equal(1, MuiPlotMath.Peak(channels));
        }

        [Theory]
        [InlineData(5, 8, 0.625)]
        [InlineData(0, 8, 0)]
        [InlineData(8, 8, 1)]
        public void BarHeightFraction_ScalesRelativeToPeak(double value, double peak, double expected)
        {
            Assert.Equal(expected, MuiPlotMath.BarHeightFraction(value, peak));
        }

        [Fact]
        public void BarHeightFraction_NonPositivePeak_ReturnsZero()
        {
            Assert.Equal(0, MuiPlotMath.BarHeightFraction(5, 0));
            Assert.Equal(0, MuiPlotMath.BarHeightFraction(5, -1));
        }

        [Theory]
        [InlineData(-0.5, 0)]
        [InlineData(1.5, 1)]
        [InlineData(0.3, 0.3)]
        public void ClampUnit_BoundsIntoZeroToOne(double value, double expected)
        {
            Assert.Equal(expected, MuiPlotMath.ClampUnit(value));
        }

        [Fact]
        public void LaneWidth_ThreeLanes_SplitsEvenlyMinusGaps()
        {
            // (100 - 4*2) / 3
            Assert.Equal(30.667, MuiPlotMath.LaneWidth(3, 100, 4), 3);
        }

        [Fact]
        public void LaneWidth_NonPositiveLaneCount_ReturnsFullWidth()
        {
            Assert.Equal(100, MuiPlotMath.LaneWidth(0, 100, 4));
        }

        [Fact]
        public void LaneX_FirstLaneStartsAtZero()
        {
            Assert.Equal(0, MuiPlotMath.LaneX(0, 3, 100, 4));
        }

        [Fact]
        public void LaneX_SubsequentLanesStepByLaneWidthPlusGap()
        {
            Assert.Equal(34.667, MuiPlotMath.LaneX(1, 3, 100, 4), 3);
            Assert.Equal(69.333, MuiPlotMath.LaneX(2, 3, 100, 4), 3);
        }
    }
}
