// MuiCropOverlayMathTests — the 8-handle resize math behind the Maple.UI
// Crop Overlay organism (Maple.WinUI/MapleUI/Organisms/MuiCropOverlayMath.cs,
// wave N6, #3012). No WinUI/live Window involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiCropOverlayMathTests
    {
        private static readonly MuiCropRect Rect = new(100, 100, 200, 150);

        [Fact]
        public void ApplyHandleDelta_Right_ExtendsRightEdgeOnly()
        {
            var result = MuiCropOverlayMath.ApplyHandleDelta(Rect, MuiCropHandle.Right, 30, 0, 1000, 1000);
            Assert.Equal(100, result.X);
            Assert.Equal(230, result.Width);
            Assert.Equal(150, result.Height);
        }

        [Fact]
        public void ApplyHandleDelta_Left_MovesLeftEdgeAndShrinksWidth()
        {
            var result = MuiCropOverlayMath.ApplyHandleDelta(Rect, MuiCropHandle.Left, 30, 0, 1000, 1000);
            Assert.Equal(130, result.X);
            Assert.Equal(170, result.Width);
        }

        [Fact]
        public void ApplyHandleDelta_TopLeft_MovesBothEdges()
        {
            var result = MuiCropOverlayMath.ApplyHandleDelta(Rect, MuiCropHandle.TopLeft, 10, 20, 1000, 1000);
            Assert.Equal(110, result.X);
            Assert.Equal(120, result.Y);
            Assert.Equal(190, result.Width);
            Assert.Equal(130, result.Height);
        }

        [Fact]
        public void ApplyHandleDelta_Right_ClampsAtBoundsWidth()
        {
            var result = MuiCropOverlayMath.ApplyHandleDelta(Rect, MuiCropHandle.Right, 10000, 0, 400, 1000);
            Assert.Equal(400, result.Right);
        }

        [Fact]
        public void ApplyHandleDelta_Left_ClampsAtZero()
        {
            var result = MuiCropOverlayMath.ApplyHandleDelta(Rect, MuiCropHandle.Left, -10000, 0, 1000, 1000);
            Assert.Equal(0, result.X);
        }

        [Fact]
        public void ApplyHandleDelta_Right_CannotCrossLeftEdgeBelowMinSize()
        {
            var result = MuiCropOverlayMath.ApplyHandleDelta(Rect, MuiCropHandle.Right, -10000, 0, 1000, 1000);
            Assert.Equal(MuiCropOverlayMath.MinSize, result.Width);
            Assert.Equal(100 + MuiCropOverlayMath.MinSize, result.Right);
        }

        [Fact]
        public void ApplyHandleDelta_Left_CannotCrossRightEdgeBelowMinSize()
        {
            var result = MuiCropOverlayMath.ApplyHandleDelta(Rect, MuiCropHandle.Left, 10000, 0, 1000, 1000);
            Assert.Equal(MuiCropOverlayMath.MinSize, result.Width);
            Assert.Equal(300 - MuiCropOverlayMath.MinSize, result.X);
        }

        [Fact]
        public void ApplyHandleDelta_Bottom_ExtendsHeightOnly()
        {
            var result = MuiCropOverlayMath.ApplyHandleDelta(Rect, MuiCropHandle.Bottom, 0, 40, 1000, 1000);
            Assert.Equal(190, result.Height);
            Assert.Equal(200, result.Width);
        }

        [Fact]
        public void Translate_MovesBothAxesWithinBounds()
        {
            var result = MuiCropOverlayMath.Translate(Rect, 20, -10, 1000, 1000);
            Assert.Equal(120, result.X);
            Assert.Equal(90, result.Y);
            Assert.Equal(Rect.Width, result.Width);
        }

        [Fact]
        public void Translate_ClampsAtRightBound()
        {
            var result = MuiCropOverlayMath.Translate(Rect, 10000, 0, 400, 1000);
            Assert.Equal(200, result.X); // 400 - 200 width
        }

        [Fact]
        public void Translate_ClampsAtZero()
        {
            var result = MuiCropOverlayMath.Translate(Rect, -10000, -10000, 1000, 1000);
            Assert.Equal(0, result.X);
            Assert.Equal(0, result.Y);
        }

        // --- MN2 (#3051) extensions: per-axis minimums + aspect lock ---

        [Fact]
        public void ApplyHandleDelta_PerAxisMinimums_FloorEachAxisIndependently()
        {
            var result = MuiCropOverlayMath.ApplyHandleDelta(
                Rect, MuiCropHandle.BottomRight, -10000, -10000, 1000, 1000,
                minWidth: 120, minHeight: 40);
            Assert.Equal(120, result.Width);
            Assert.Equal(40, result.Height);
        }

        [Fact]
        public void ApplyHandleDelta_DefaultOverload_KeepsFixedMinSize()
        {
            var result = MuiCropOverlayMath.ApplyHandleDelta(
                Rect, MuiCropHandle.BottomRight, -10000, -10000, 1000, 1000);
            Assert.Equal(MuiCropOverlayMath.MinSize, result.Width);
            Assert.Equal(MuiCropOverlayMath.MinSize, result.Height);
        }

        [Fact]
        public void ConstrainAspect_EdgeHandle_RederivesOtherAxisCentered()
        {
            // Width 200 at 2:1 → height 100, re-centered on the old midline (175).
            var result = MuiCropOverlayMath.ConstrainAspect(Rect, MuiCropHandle.Right, 2.0, 1000, 1000);
            Assert.Equal(100, result.X);
            Assert.Equal(200, result.Width);
            Assert.Equal(100, result.Height, 10);
            Assert.Equal(125, result.Y, 10);
        }

        [Fact]
        public void ConstrainAspect_TopBottomHandle_RederivesWidthCentered()
        {
            // Height 150 at 2:1 → width 300, re-centered on the old midline (200).
            var result = MuiCropOverlayMath.ConstrainAspect(Rect, MuiCropHandle.Bottom, 2.0, 1000, 1000);
            Assert.Equal(300, result.Width, 10);
            Assert.Equal(50, result.X, 10);
            Assert.Equal(150, result.Height);
        }

        [Fact]
        public void ConstrainAspect_TopCorner_AnchorsOnBottomEdge()
        {
            // Height follows width (200 at 1:1 → 200), bottom edge (250) stays put.
            var result = MuiCropOverlayMath.ConstrainAspect(Rect, MuiCropHandle.TopLeft, 1.0, 1000, 1000);
            Assert.Equal(200, result.Height, 10);
            Assert.Equal(250, result.Bottom, 10);
        }

        [Fact]
        public void ConstrainAspect_BottomCorner_AnchorsOnTopEdge()
        {
            var result = MuiCropOverlayMath.ConstrainAspect(Rect, MuiCropHandle.BottomRight, 1.0, 1000, 1000);
            Assert.Equal(200, result.Height, 10);
            Assert.Equal(100, result.Top, 10);
        }

        [Fact]
        public void ConstrainAspect_ClampsAgainstBounds_OverRatio()
        {
            // Bottom corner at 1:1 wants height 200 but only 160 fits below
            // top=100 in a 260-tall bounds — the bounds clamp wins.
            var result = MuiCropOverlayMath.ConstrainAspect(Rect, MuiCropHandle.BottomRight, 1.0, 1000, 260);
            Assert.Equal(160, result.Height, 10);
            Assert.Equal(260, result.Bottom, 10);
        }
    }
}
