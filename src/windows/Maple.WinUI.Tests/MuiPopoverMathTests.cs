// MuiPopoverMathTests — the pure placement math behind the Maple.UI
// Popover primitive (Maple.WinUI/MapleUI/Molecules/MuiPopoverMath.cs, wave
// N3b of the Windows Maple.UI molecules, #3012). No WinUI/live Window
// involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiPopoverMathTests
    {
        // Anchor at (10, 20), 100x40; panel 50x30; default gap 6.
        private const double AnchorX = 10, AnchorY = 20, AnchorW = 100, AnchorH = 40;
        private const double PanelW = 50, PanelH = 30;

        [Fact]
        public void ComputeOffset_Bottom_CentersUnderneathWithGap()
        {
            var (x, y) = MuiPopoverMath.ComputeOffset(AnchorX, AnchorY, AnchorW, AnchorH, PanelW, PanelH, MuiPopoverPlacement.Bottom);
            Assert.Equal(35, x);
            Assert.Equal(66, y);
        }

        [Fact]
        public void ComputeOffset_Top_CentersAboveWithGap()
        {
            var (x, y) = MuiPopoverMath.ComputeOffset(AnchorX, AnchorY, AnchorW, AnchorH, PanelW, PanelH, MuiPopoverPlacement.Top);
            Assert.Equal(35, x);
            Assert.Equal(-16, y);
        }

        [Fact]
        public void ComputeOffset_Left_CentersBesideWithGap()
        {
            var (x, y) = MuiPopoverMath.ComputeOffset(AnchorX, AnchorY, AnchorW, AnchorH, PanelW, PanelH, MuiPopoverPlacement.Left);
            Assert.Equal(-46, x);
            Assert.Equal(25, y);
        }

        [Fact]
        public void ComputeOffset_Right_CentersBesideWithGap()
        {
            var (x, y) = MuiPopoverMath.ComputeOffset(AnchorX, AnchorY, AnchorW, AnchorH, PanelW, PanelH, MuiPopoverPlacement.Right);
            Assert.Equal(116, x);
            Assert.Equal(25, y);
        }

        [Fact]
        public void ComputeOffset_CustomGap_IsHonored()
        {
            var (_, y) = MuiPopoverMath.ComputeOffset(AnchorX, AnchorY, AnchorW, AnchorH, PanelW, PanelH, MuiPopoverPlacement.Bottom, gap: 0);
            Assert.Equal(60, y); // anchorY + anchorH, no gap
        }

        [Fact]
        public void ClampToViewport_NegativePosition_ClampsToZero()
        {
            var (x, y) = MuiPopoverMath.ClampToViewport(-46, 25, PanelW, PanelH, viewportWidth: 200, viewportHeight: 100);
            Assert.Equal(0, x);
            Assert.Equal(25, y);
        }

        [Fact]
        public void ClampToViewport_OverflowingRight_ClampsToMax()
        {
            var (x, _) = MuiPopoverMath.ClampToViewport(180, 25, PanelW, PanelH, viewportWidth: 200, viewportHeight: 100);
            Assert.Equal(150, x); // 200 - 50
        }

        [Fact]
        public void ClampToViewport_PanelWiderThanViewport_PinsToZero()
        {
            var (x, _) = MuiPopoverMath.ClampToViewport(50, 25, panelWidth: 300, panelHeight: 30, viewportWidth: 200, viewportHeight: 100);
            Assert.Equal(0, x);
        }
    }
}
