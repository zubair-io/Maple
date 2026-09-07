// WhiteBalancePickLogicTests — the canvas-click → normalised-point half of
// the Windows eyedropper (#2434). The click arrives in the content host's
// coordinate space (already un-rotated and un-zoomed by WinUI's
// GetCurrentPoint), the image sits on a fit footprint inside that host, and
// the sampler wants a [0, 1] point in the uncropped display-oriented frame.

using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class WhiteBalancePickLogicTests
    {
        // A 400×300 footprint offset (50, 100) inside the host.
        private const double Fx = 50, Fy = 100, Fw = 400, Fh = 300;

        [Fact]
        public void PointInsideTheFootprintNormalisesAgainstIt()
        {
            var point = WhiteBalancePickLogic.Normalize(150, 175, Fx, Fy, Fw, Fh);
            Assert.NotNull(point);
            Assert.Equal(0.25, point!.Value.X, 12);
            Assert.Equal(0.25, point.Value.Y, 12);
        }

        [Fact]
        public void EdgesAreInside()
        {
            Assert.Equal((0.0, 0.0), WhiteBalancePickLogic.Normalize(Fx, Fy, Fx, Fy, Fw, Fh));
            Assert.Equal((1.0, 1.0), WhiteBalancePickLogic.Normalize(Fx + Fw, Fy + Fh, Fx, Fy, Fw, Fh));
        }

        [Theory]
        [InlineData(49, 200)]
        [InlineData(451, 200)]
        [InlineData(200, 99)]
        [InlineData(200, 401)]
        public void PointOutsideTheFootprintIsRejected(double x, double y)
        {
            Assert.Null(WhiteBalancePickLogic.Normalize(x, y, Fx, Fy, Fw, Fh));
        }

        [Fact]
        public void DegenerateFootprintIsRejected()
        {
            Assert.Null(WhiteBalancePickLogic.Normalize(100, 100, Fx, Fy, 0, Fh));
            Assert.Null(WhiteBalancePickLogic.Normalize(100, 100, Fx, Fy, Fw, 0));
        }

        [Fact]
        public void AClickIsAReleaseThatBarelyMoved()
        {
            Assert.True(WhiteBalancePickLogic.IsClick(10, 10, 12, 13));
            Assert.False(WhiteBalancePickLogic.IsClick(10, 10, 30, 10));
            Assert.False(WhiteBalancePickLogic.IsClick(10, 10, 10, -5));
        }
    }
}
