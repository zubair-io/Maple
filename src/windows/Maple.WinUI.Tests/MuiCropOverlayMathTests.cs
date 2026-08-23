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
    }
}
