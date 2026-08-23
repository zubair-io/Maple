// MuiFrameTimeClassifierTests — the pure budget classification behind the
// Maple.UI Frame-time HUD molecule (Maple.WinUI/MapleUI/Molecules/
// MuiFrameTimeClassifier.cs, wave N3a of the Windows Maple.UI molecules,
// #3012). No WinUI/live Window involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiFrameTimeClassifierTests
    {
        [Theory]
        [InlineData(1)]
        [InlineData(15.9)]
        [InlineData(16)] // exactly at budget is still Good — the check is strictly-greater-than.
        public void Classify_AtOrUnderBudget_IsGood(double frameMs)
        {
            Assert.Equal(MuiFrameTimeStatus.Good, MuiFrameTimeClassifier.Classify(frameMs));
        }

        [Theory]
        [InlineData(16.1)]
        [InlineData(33)]
        [InlineData(50)] // exactly at the hard limit is still Warn.
        public void Classify_BetweenBudgetAndHardLimit_IsWarn(double frameMs)
        {
            Assert.Equal(MuiFrameTimeStatus.Warn, MuiFrameTimeClassifier.Classify(frameMs));
        }

        [Theory]
        [InlineData(50.1)]
        [InlineData(200)]
        public void Classify_OverHardLimit_IsBad(double frameMs)
        {
            Assert.Equal(MuiFrameTimeStatus.Bad, MuiFrameTimeClassifier.Classify(frameMs));
        }

        [Fact]
        public void Classify_CustomBudgets_OverridesDefaults()
        {
            Assert.Equal(MuiFrameTimeStatus.Good, MuiFrameTimeClassifier.Classify(30, budgetMs: 33, hardLimitMs: 66));
            Assert.Equal(MuiFrameTimeStatus.Bad, MuiFrameTimeClassifier.Classify(30, budgetMs: 5, hardLimitMs: 10));
        }

        [Fact]
        public void ComputeFps_DerivesFromFrameTime()
        {
            Assert.Equal(60, MuiFrameTimeClassifier.ComputeFps(16.666, explicitFps: null));
            Assert.Equal(30, MuiFrameTimeClassifier.ComputeFps(33.333, explicitFps: null));
        }

        [Fact]
        public void ComputeFps_ExplicitValue_OverridesDerivation()
        {
            Assert.Equal(144, MuiFrameTimeClassifier.ComputeFps(16, explicitFps: 144));
        }

        [Fact]
        public void ComputeFps_NonPositiveFrameTime_ReturnsZero()
        {
            Assert.Equal(0, MuiFrameTimeClassifier.ComputeFps(0, explicitFps: null));
            Assert.Equal(0, MuiFrameTimeClassifier.ComputeFps(-5, explicitFps: null));
        }
    }
}
