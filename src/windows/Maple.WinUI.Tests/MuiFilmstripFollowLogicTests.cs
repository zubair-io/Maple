// MuiFilmstripFollowLogicTests — the active-follow scroll math behind
// the Maple.UI Filmstrip Row/Rail molecules
// (Maple.WinUI/MapleUI/MoleculesL2/MuiFilmstripFollowLogic.cs, wave N4 of
// the Windows Maple.UI molecules L2, #3012). No WinUI/live Window/
// ScrollViewer involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiFilmstripFollowLogicTests
    {
        // Both strips feed actual laid-out cell bounds (chrome and metadata
        // row included) into FollowBounds; the Rail cases below are the
        // vertical axis (#3402), the math is axis-agnostic.

        [Fact]
        public void CellSpacing_IsSharedByBothStrips()
        {
            Assert.Equal(8, MuiFilmstripFollowLogic.CellSpacing);
        }

        [Fact]
        public void RailFollow_CellBelowViewport_ScrollsItsBottomToTheViewportBottom()
        {
            // 72px thumbnails have additional cell chrome and metadata. The
            // measured cell spans [1260, 1378), not the guessed [800, 872).
            var offset = MuiFilmstripFollowLogic.FollowBounds(
                itemStart: 1260, itemExtent: 118,
                viewportExtent: 400, currentOffset: 0);

            Assert.Equal(978, offset);
        }

        [Fact]
        public void RailFollow_CellAboveViewport_ScrollsItsTopToTheViewportTop()
        {
            var offset = MuiFilmstripFollowLogic.FollowBounds(
                itemStart: 252, itemExtent: 118,
                viewportExtent: 400, currentOffset: 500);

            Assert.Equal(252, offset);
        }

        [Fact]
        public void RailFollow_CellInsideViewport_DoesNotScroll()
        {
            var offset = MuiFilmstripFollowLogic.FollowBounds(
                itemStart: 560, itemExtent: 118,
                viewportExtent: 400, currentOffset: 300);

            Assert.Equal(300, offset);
        }

        [Fact]
        public void FollowBounds_ViewportShorterThanCell_DoesNotBounceBetweenEdges()
        {
            var first = MuiFilmstripFollowLogic.FollowBounds(252, 118, 80, 0);
            var next = MuiFilmstripFollowLogic.FollowBounds(252, 118, 80, first);
            Assert.Equal(252, first);
            Assert.Equal(first, next);
        }

        [Theory]
        [InlineData(0, 400)]
        [InlineData(118, 0)]
        public void FollowBounds_NotLaidOut_PreservesOffset(double itemExtent, double viewportExtent)
        {
            Assert.Equal(40, MuiFilmstripFollowLogic.FollowBounds(252, itemExtent, viewportExtent, 40));
        }
    }
}
