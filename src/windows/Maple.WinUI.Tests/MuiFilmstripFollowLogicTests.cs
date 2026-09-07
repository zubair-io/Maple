// MuiFilmstripFollowLogicTests — the active-follow index/scroll math behind
// the Maple.UI Filmstrip Row/Rail molecules
// (Maple.WinUI/MapleUI/MoleculesL2/MuiFilmstripFollowLogic.cs, wave N4 of
// the Windows Maple.UI molecules L2, #3012). No WinUI/live Window/
// ScrollViewer involved.

using System.Collections.Generic;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiFilmstripFollowLogicTests
    {
        private static readonly List<string> Ids = new() { "a", "b", "c", "d" };

        [Fact]
        public void IndexOf_KnownId_ReturnsItsIndex()
        {
            Assert.Equal(2, MuiFilmstripFollowLogic.IndexOf(Ids, "c"));
        }

        [Fact]
        public void IndexOf_NullActiveId_ReturnsNegativeOne()
        {
            Assert.Equal(-1, MuiFilmstripFollowLogic.IndexOf(Ids, null));
        }

        [Fact]
        public void IndexOf_UnknownId_ReturnsNegativeOne()
        {
            Assert.Equal(-1, MuiFilmstripFollowLogic.IndexOf(Ids, "nope"));
        }

        [Fact]
        public void FollowOffset_NegativeIndex_ReturnsCurrentOffsetUnchanged()
        {
            var offset = MuiFilmstripFollowLogic.FollowOffset(
                index: -1, itemExtent: 72, spacing: 8, viewportExtent: 300, currentOffset: 40);

            Assert.Equal(40, offset);
        }

        [Fact]
        public void FollowOffset_CellAlreadyFullyVisible_LeavesOffsetUnchanged()
        {
            // Cell 1 spans [80, 152) with 72-wide cells + 8 spacing; a
            // [0, 300) viewport at offset 0 already shows it fully.
            var offset = MuiFilmstripFollowLogic.FollowOffset(
                index: 1, itemExtent: 72, spacing: 8, viewportExtent: 300, currentOffset: 0);

            Assert.Equal(0, offset);
        }

        [Fact]
        public void FollowOffset_CellOffLeadingEdge_SnapsStartToViewportStart()
        {
            // Cell 0 starts at 0; scrolled past it (offset 100) hides it off
            // the leading edge, so the minimum-distance scroll is back to 0.
            var offset = MuiFilmstripFollowLogic.FollowOffset(
                index: 0, itemExtent: 72, spacing: 8, viewportExtent: 200, currentOffset: 100);

            Assert.Equal(0, offset);
        }

        [Fact]
        public void FollowOffset_CellOffTrailingEdge_SnapsEndToViewportEnd()
        {
            // Cell 4 spans [320, 392) with 72-wide cells + 8 spacing; a
            // 200-wide viewport at offset 0 doesn't reach it, so the cell's
            // end (392) becomes the new viewport's trailing edge.
            var offset = MuiFilmstripFollowLogic.FollowOffset(
                index: 4, itemExtent: 72, spacing: 8, viewportExtent: 200, currentOffset: 0);

            Assert.Equal(192, offset); // 392 - 200
        }

        // --- Filmstrip Rail (#3402): the same math on the vertical axis, fed
        // the shared cell geometry the Row and Rail controls both draw with.

        [Fact]
        public void CellGeometry_IsTheSharedSmMediaCellStrip()
        {
            Assert.Equal(72, MuiFilmstripFollowLogic.CellExtent);
            Assert.Equal(8, MuiFilmstripFollowLogic.CellSpacing);
        }

        [Fact]
        public void RailFollow_CellBelowViewport_ScrollsItsBottomToTheViewportBottom()
        {
            // Cell 10 spans [800, 872) vertically; a 400-tall rail scrolled to
            // the top ends at 400, so the rail scrolls down until 872 is its
            // bottom edge.
            var offset = MuiFilmstripFollowLogic.FollowOffset(
                index: 10,
                MuiFilmstripFollowLogic.CellExtent, MuiFilmstripFollowLogic.CellSpacing,
                viewportExtent: 400, currentOffset: 0);

            Assert.Equal(472, offset); // 872 - 400
        }

        [Fact]
        public void RailFollow_CellAboveViewport_ScrollsItsTopToTheViewportTop()
        {
            // Cell 2 starts at 160; the rail is scrolled well past it (500),
            // so it scrolls back up until 160 is its top edge.
            var offset = MuiFilmstripFollowLogic.FollowOffset(
                index: 2,
                MuiFilmstripFollowLogic.CellExtent, MuiFilmstripFollowLogic.CellSpacing,
                viewportExtent: 400, currentOffset: 500);

            Assert.Equal(160, offset);
        }

        [Fact]
        public void RailFollow_CellInsideViewport_DoesNotScroll()
        {
            // Cell 7 spans [560, 632); a 400-tall rail at offset 300 shows
            // [300, 700), which already contains it.
            var offset = MuiFilmstripFollowLogic.FollowOffset(
                index: 7,
                MuiFilmstripFollowLogic.CellExtent, MuiFilmstripFollowLogic.CellSpacing,
                viewportExtent: 400, currentOffset: 300);

            Assert.Equal(300, offset);
        }
    }
}
