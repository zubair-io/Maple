// MuiToolbarMathTests — the pure overflow-split math behind the Maple.UI
// Toolbar molecule (Maple.WinUI/MapleUI/Molecules/MuiToolbarMath.cs, wave
// N3b of the Windows Maple.UI molecules, #3012). No WinUI/live Window
// involved.

using System.Collections.Generic;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiToolbarMathTests
    {
        private static MuiToolbarItem Item(string id) => new(id, "gear", id);

        [Fact]
        public void Split_UnderBudget_EverythingVisibleNoOverflow()
        {
            var entries = new List<MuiToolbarEntry> { MuiToolbarEntry.For(Item("a")), MuiToolbarEntry.For(Item("b")) };
            var split = MuiToolbarMath.Split(entries, maxVisible: 5);
            Assert.Equal(2, split.Visible.Count);
            Assert.Empty(split.Overflow);
        }

        [Fact]
        public void Split_OverBudget_KeepsDividerBeforeOverflowStarts_MovesRestToOverflow()
        {
            var entries = new List<MuiToolbarEntry>
            {
                MuiToolbarEntry.For(Item("a")),
                MuiToolbarEntry.For(Item("b")),
                MuiToolbarEntry.Divider(),
                MuiToolbarEntry.For(Item("c")),
                MuiToolbarEntry.For(Item("d")),
                MuiToolbarEntry.For(Item("e")),
            };
            var split = MuiToolbarMath.Split(entries, maxVisible: 3);

            Assert.Equal(4, split.Visible.Count); // a, b, divider, c
            Assert.True(split.Visible[2].IsDivider);
            Assert.Equal(2, split.Overflow.Count);
            Assert.Equal("d", split.Overflow[0].Id);
            Assert.Equal("e", split.Overflow[1].Id);
        }

        [Fact]
        public void Split_TrailingDividerAtOverflowBoundary_IsDroppedFromBothLists()
        {
            var entries = new List<MuiToolbarEntry>
            {
                MuiToolbarEntry.For(Item("a")),
                MuiToolbarEntry.For(Item("b")),
                MuiToolbarEntry.For(Item("c")),
                MuiToolbarEntry.Divider(),
            };
            var split = MuiToolbarMath.Split(entries, maxVisible: 2);

            Assert.Equal(2, split.Visible.Count); // a, b — divider dropped
            Assert.Single(split.Overflow);
            Assert.Equal("c", split.Overflow[0].Id);
        }

        [Fact]
        public void Split_ZeroMaxVisible_EverythingOverflows()
        {
            var entries = new List<MuiToolbarEntry> { MuiToolbarEntry.For(Item("a")), MuiToolbarEntry.For(Item("b")) };
            var split = MuiToolbarMath.Split(entries, maxVisible: 0);
            Assert.Empty(split.Visible);
            Assert.Equal(2, split.Overflow.Count);
        }

        [Fact]
        public void Split_EmptyEntries_EmptyBothLists()
        {
            var split = MuiToolbarMath.Split(new List<MuiToolbarEntry>(), maxVisible: 3);
            Assert.Empty(split.Visible);
            Assert.Empty(split.Overflow);
        }
    }
}
