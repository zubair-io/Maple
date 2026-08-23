// MuiPad2DMathTests — the pure pointer<->value math behind the Maple.UI
// 2-D Pad molecule (Maple.WinUI/MapleUI/Molecules/MuiPad2DMath.cs, wave
// N3a of the Windows Maple.UI molecules, #3012). No WinUI/live Window
// involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiPad2DMathTests
    {
        [Fact]
        public void PointerToValue_TopLeft_IsMinXMaxY()
        {
            var result = MuiPad2DMath.PointerToValue(0, 0, -100, 100, -100, 100);
            Assert.Equal(-100, result.X);
            Assert.Equal(100, result.Y);
        }

        [Fact]
        public void PointerToValue_BottomRight_IsMaxXMinY()
        {
            var result = MuiPad2DMath.PointerToValue(1, 1, -100, 100, -100, 100);
            Assert.Equal(100, result.X);
            Assert.Equal(-100, result.Y);
        }

        [Fact]
        public void PointerToValue_Center_IsMidpointOfBothAxes()
        {
            var result = MuiPad2DMath.PointerToValue(0.5, 0.5, 0, 100, 0, 200);
            Assert.Equal(50, result.X);
            Assert.Equal(100, result.Y);
        }

        [Fact]
        public void PointerToValue_DegenerateXRange_PinsXToItsSingleValue()
        {
            var result = MuiPad2DMath.PointerToValue(0.9, 0.5, 5, 5, -100, 100);
            Assert.Equal(5, result.X);
        }

        [Fact]
        public void ValueToUnitPosition_MinXMaxY_IsTopLeft()
        {
            var (x, y) = MuiPad2DMath.ValueToUnitPosition(-100, 100, -100, 100, -100, 100);
            Assert.Equal(0, x, precision: 6);
            Assert.Equal(0, y, precision: 6);
        }

        [Fact]
        public void ValueToUnitPosition_DegenerateRange_CentersThatAxis()
        {
            var (x, _) = MuiPad2DMath.ValueToUnitPosition(5, 0, 5, 5, -100, 100);
            Assert.Equal(0.5, x, precision: 6);
        }

        [Fact]
        public void RoundTrip_ValueToPositionAndBack_RecoversTheOriginalValue()
        {
            var original = new MuiPad2DValue(37, -18);
            var (x, y) = MuiPad2DMath.ValueToUnitPosition(original.X, original.Y, -100, 100, -100, 100);
            var recovered = MuiPad2DMath.PointerToValue(x, y, -100, 100, -100, 100);
            Assert.Equal(original.X, recovered.X, precision: 6);
            Assert.Equal(original.Y, recovered.Y, precision: 6);
        }
    }
}
