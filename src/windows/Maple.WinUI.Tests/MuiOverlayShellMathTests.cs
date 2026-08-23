// MuiOverlayShellMathTests — the size-to-pixel-width mapping behind the
// Maple.UI Overlay Shell template
// (Maple.WinUI/MapleUI/Templates/MuiOverlayShellMath.cs, wave N5 of the
// Windows Maple.UI templates, #3012). No WinUI/live Window involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiOverlayShellMathTests
    {
        [Fact]
        public void MaxWidthFor_Sm_Returns360()
        {
            Assert.Equal(360.0, MuiOverlayShellMath.MaxWidthFor(MuiOverlayShellSize.Sm));
        }

        [Fact]
        public void MaxWidthFor_Md_Returns560()
        {
            Assert.Equal(560.0, MuiOverlayShellMath.MaxWidthFor(MuiOverlayShellSize.Md));
        }

        [Fact]
        public void MaxWidthFor_Lg_Returns800()
        {
            Assert.Equal(800.0, MuiOverlayShellMath.MaxWidthFor(MuiOverlayShellSize.Lg));
        }

        [Fact]
        public void MaxWidthFor_Full_ReturnsPositiveInfinity()
        {
            Assert.Equal(double.PositiveInfinity, MuiOverlayShellMath.MaxWidthFor(MuiOverlayShellSize.Full));
        }
    }
}
