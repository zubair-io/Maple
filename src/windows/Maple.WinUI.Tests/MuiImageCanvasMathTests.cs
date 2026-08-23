// MuiImageCanvasMathTests — the zoom/pan transform math behind the
// Maple.UI Image Canvas organism (Maple.WinUI/MapleUI/Organisms/MuiImageCanvasMath.cs,
// wave N6, #3012). No WinUI/live Window involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiImageCanvasMathTests
    {
        [Fact]
        public void ClampZoom_BelowMinimum_ClampsToMinimum()
        {
            Assert.Equal(MuiImageCanvasMath.MinZoom, MuiImageCanvasMath.ClampZoom(0.01));
        }

        [Fact]
        public void ClampZoom_AboveMaximum_ClampsToMaximum()
        {
            Assert.Equal(MuiImageCanvasMath.MaxZoom, MuiImageCanvasMath.ClampZoom(50));
        }

        [Fact]
        public void ClampZoom_WithinRange_IsUnchanged()
        {
            Assert.Equal(2.0, MuiImageCanvasMath.ClampZoom(2.0));
        }

        [Fact]
        public void ZoomForWheelDelta_Positive_IncreasesZoom()
        {
            var result = MuiImageCanvasMath.ZoomForWheelDelta(1.0, 120);
            Assert.True(result > 1.0);
        }

        [Fact]
        public void ZoomForWheelDelta_Negative_DecreasesZoom()
        {
            var result = MuiImageCanvasMath.ZoomForWheelDelta(1.0, -120);
            Assert.True(result < 1.0);
        }

        [Fact]
        public void ZoomForWheelDelta_ClampsAtMaximum()
        {
            var result = MuiImageCanvasMath.ZoomForWheelDelta(MuiImageCanvasMath.MaxZoom, 120);
            Assert.Equal(MuiImageCanvasMath.MaxZoom, result);
        }

        [Fact]
        public void FitZoom_LandscapeImageInSquareViewport_FitsByWidth()
        {
            var zoom = MuiImageCanvasMath.FitZoom(500, 500, 1000, 500);
            Assert.Equal(0.5, zoom, 3);
        }

        [Fact]
        public void FitZoom_PortraitImageInSquareViewport_FitsByHeight()
        {
            var zoom = MuiImageCanvasMath.FitZoom(500, 500, 500, 1000);
            Assert.Equal(0.5, zoom, 3);
        }

        [Fact]
        public void FitZoom_ZeroImageDimension_ReturnsOne()
        {
            Assert.Equal(1.0, MuiImageCanvasMath.FitZoom(500, 500, 0, 500));
        }

        [Fact]
        public void ClampPan_ImageSmallerThanViewport_PinsToZero()
        {
            var (x, y) = MuiImageCanvasMath.ClampPan(50, 50, 800, 600, 200, 150, 1.0);
            Assert.Equal(0, x);
            Assert.Equal(0, y);
        }

        [Fact]
        public void ClampPan_ImageLargerThanViewport_ClampsToHalfOverflow()
        {
            // scaled image 1000x1000 in an 800x600 viewport -> maxX=(1000-800)/2=100, maxY=(1000-600)/2=200
            var (x, y) = MuiImageCanvasMath.ClampPan(500, 500, 800, 600, 1000, 1000, 1.0);
            Assert.Equal(100, x);
            Assert.Equal(200, y);
        }

        [Fact]
        public void ClampPan_NegativeOverflow_ClampsSymmetrically()
        {
            var (x, _) = MuiImageCanvasMath.ClampPan(-500, 0, 800, 600, 1000, 1000, 1.0);
            Assert.Equal(-100, x);
        }
    }
}
