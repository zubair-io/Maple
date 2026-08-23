// MuiColorWheelMathTests — the pure pointer<->value math behind the
// Maple.UI Color Wheel molecule (Maple.WinUI/MapleUI/Molecules/
// MuiColorWheelMath.cs, wave N3a of the Windows Maple.UI molecules, #3012).
// No WinUI/live Window involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiColorWheelMathTests
    {
        [Theory]
        [InlineData(0, 0)]
        [InlineData(360, 0)]
        [InlineData(-10, 350)]
        [InlineData(370, 10)]
        [InlineData(-370, 350)]
        public void WrapHue_NormalizesToZeroThrough360(double input, double expected)
        {
            Assert.Equal(expected, MuiColorWheelMath.WrapHue(input));
        }

        [Fact]
        public void PointerToValue_CenterPointer_ReturnsZeroSaturationAndFallbackHue()
        {
            var result = MuiColorWheelMath.PointerToValue(0.5, 0.5, fallbackHue: 123);
            Assert.Equal(0, result.Saturation);
            Assert.Equal(123, result.Hue);
        }

        [Fact]
        public void PointerToValue_RightEdgeMiddle_IsHueZeroFullSaturation()
        {
            // x=1 (right edge), y=0.5 (vertical center) -> hue 0, saturation 100.
            var result = MuiColorWheelMath.PointerToValue(1.0, 0.5, fallbackHue: 0);
            Assert.Equal(0, result.Hue);
            Assert.Equal(100, result.Saturation);
        }

        [Fact]
        public void PointerToValue_TopEdgeMiddle_IsHue90()
        {
            // y=0 is the TOP in pointer space (down-positive), which is
            // y-up +1 after the flip -> hue 90.
            var result = MuiColorWheelMath.PointerToValue(0.5, 0.0, fallbackHue: 0);
            Assert.Equal(90, result.Hue);
            Assert.Equal(100, result.Saturation);
        }

        [Fact]
        public void PointerToValue_BeyondTheWheel_ClampsSaturationTo100()
        {
            var result = MuiColorWheelMath.PointerToValue(2.0, 0.5, fallbackHue: 0);
            Assert.Equal(100, result.Saturation);
        }

        [Fact]
        public void ValueToUnitPosition_ZeroSaturation_IsCenter()
        {
            var (x, y) = MuiColorWheelMath.ValueToUnitPosition(hue: 200, saturation: 0);
            Assert.Equal(0.5, x, precision: 6);
            Assert.Equal(0.5, y, precision: 6);
        }

        [Fact]
        public void ValueToUnitPosition_HueZeroFullSaturation_IsRightEdgeMiddle()
        {
            var (x, y) = MuiColorWheelMath.ValueToUnitPosition(hue: 0, saturation: 100);
            Assert.Equal(1.0, x, precision: 6);
            Assert.Equal(0.5, y, precision: 6);
        }

        [Fact]
        public void RoundTrip_ValueToPositionAndBack_RecoversTheOriginalValue()
        {
            var original = new MuiColorWheelValue(72, 64);
            var (x, y) = MuiColorWheelMath.ValueToUnitPosition(original.Hue, original.Saturation);
            var recovered = MuiColorWheelMath.PointerToValue(x, y, fallbackHue: 0);
            Assert.Equal(original.Hue, recovered.Hue, precision: 0);
            Assert.Equal(original.Saturation, recovered.Saturation, precision: 0);
        }
    }
}
