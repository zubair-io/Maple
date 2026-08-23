// MuiSliderMathTests — the pure value<->position math behind the Maple.UI
// Slider and Living Slider molecules (Maple.WinUI/MapleUI/Molecules/
// MuiSliderMath.cs, wave N3a of the Windows Maple.UI molecules, #3012). No
// WinUI/live Window involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiSliderMathTests
    {
        [Theory]
        [InlineData(50, 0, 100, 50)]
        [InlineData(0, 0, 100, 0)]
        [InlineData(100, 0, 100, 100)]
        [InlineData(-50, -100, 100, 25)]
        [InlineData(150, 0, 100, 150)] // out-of-range values extrapolate, not clamped
        public void PercentInRange_MapsValueToPercent(double value, double min, double max, double expected)
        {
            Assert.Equal(expected, MuiSliderMath.PercentInRange(value, min, max, fallbackPct: 999));
        }

        [Fact]
        public void PercentInRange_DegenerateRange_ReturnsFallback()
        {
            Assert.Equal(50, MuiSliderMath.PercentInRange(5, 10, 10, fallbackPct: 50));
        }

        [Theory]
        [InlineData(5, 0, 10, 5)]
        [InlineData(-5, 0, 10, 0)]
        [InlineData(15, 0, 10, 10)]
        public void Clamp_BoundsValueToRange(double value, double min, double max, double expected)
        {
            Assert.Equal(expected, MuiSliderMath.Clamp(value, min, max));
        }

        [Theory]
        [InlineData(2.3, 1, 2)]
        [InlineData(2.6, 1, 3)]
        [InlineData(7, 5, 5)]
        public void SnapToStep_RoundsToNearestMultiple(double raw, double step, double expected)
        {
            Assert.Equal(expected, MuiSliderMath.SnapToStep(raw, step));
        }

        [Fact]
        public void SnapToStep_NonPositiveStep_ReturnsRawUnchanged()
        {
            Assert.Equal(3.7, MuiSliderMath.SnapToStep(3.7, 0));
            Assert.Equal(3.7, MuiSliderMath.SnapToStep(3.7, -1));
        }

        [Fact]
        public void ValueFromPointerDelta_PositiveDrag_IncreasesValue()
        {
            // Half the 200px track, across a 0-100 range: +50.
            var result = MuiSliderMath.ValueFromPointerDelta(
                pointerDownValue: 0, dx: 100, trackWidth: 200, min: 0, max: 100, step: 1);
            Assert.Equal(50, result);
        }

        [Fact]
        public void ValueFromPointerDelta_ClampsToRange()
        {
            var result = MuiSliderMath.ValueFromPointerDelta(
                pointerDownValue: 90, dx: 1000, trackWidth: 200, min: 0, max: 100, step: 1);
            Assert.Equal(100, result);
        }

        [Fact]
        public void ValueFromPointerDelta_ZeroTrackWidth_LeavesValueUnchanged()
        {
            var result = MuiSliderMath.ValueFromPointerDelta(
                pointerDownValue: 42, dx: 100, trackWidth: 0, min: 0, max: 100, step: 1);
            Assert.Equal(42, result);
        }

        [Fact]
        public void ValueFromPointerDelta_SnapsToStep()
        {
            var result = MuiSliderMath.ValueFromPointerDelta(
                pointerDownValue: 0, dx: 21, trackWidth: 200, min: 0, max: 100, step: 5);
            // dx/trackWidth * range = 10.5 -> snaps to nearest 5 -> 10.
            Assert.Equal(10, result);
        }

        [Theory]
        [InlineData("Left", 1, -1)]
        [InlineData("Down", 1, -1)]
        [InlineData("Right", 2, 2)]
        [InlineData("Up", 2, 2)]
        public void ArrowKeyDelta_DirectionalKeys_ReturnSignedStep(string key, double step, double expected)
        {
            Assert.Equal(expected, MuiSliderMath.ArrowKeyDelta(key, step));
        }

        [Fact]
        public void ArrowKeyDelta_UnrelatedKey_ReturnsNull()
        {
            Assert.Null(MuiSliderMath.ArrowKeyDelta("Enter", 1));
        }

        [Theory]
        [InlineData(5, 1, "", "+5")]
        [InlineData(-5, 1, "", "-5")]
        [InlineData(0, 1, "", "0")]
        [InlineData(1.27, 0.5, "px", "+1.3 px")]
        [InlineData(1.234, 0.05, "%", "+1.23 %")]
        public void FormatSignedValue_MatchesWebPrecisionAndSign(double value, double step, string unit, string expected)
        {
            Assert.Equal(expected, MuiSliderMath.FormatSignedValue(value, step, unit));
        }
    }
}
