// SelectionLogicTests — the pure resolution rules behind the library grid's
// multi-select (#2634): which item Enter/double-tap should open, what the
// Narrator-facing summary text says, and when a selection change should
// become the well-defined single edit/preview target. SelectionLogic is
// generic over the item type (see its header comment for why), so these
// tests use plain `string` as a stand-in for PhotoItem — no WinUI, no
// EditSessionViewModel required.

using System.Collections.Generic;
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class SelectionLogicTests
    {
        // --- ResolvePrimaryTarget ---

        [Fact]
        public void ResolvePrimaryTarget_SoleSelection_ReturnsIt()
        {
            var selected = new List<string> { "b" };
            var all = new List<string> { "a", "b", "c" };

            Assert.Equal("b", SelectionLogic.ResolvePrimaryTarget(selected, "a", all));
        }

        [Fact]
        public void ResolvePrimaryTarget_MultiSelection_ReturnsFirstInSelectionOrder()
        {
            // Selection order (e.g. a shift-range or Ctrl+A) need not match
            // the view order — the first tier picks the first SELECTED item,
            // not the first item in `all`.
            var selected = new List<string> { "c", "a" };
            var all = new List<string> { "a", "b", "c" };

            Assert.Equal("c", SelectionLogic.ResolvePrimaryTarget(selected, "a", all));
        }

        [Fact]
        public void ResolvePrimaryTarget_NoSelection_FallsBackToLastSelectedItem()
        {
            var all = new List<string> { "a", "b", "c" };

            Assert.Equal("b", SelectionLogic.ResolvePrimaryTarget(new List<string>(), "b", all));
        }

        [Fact]
        public void ResolvePrimaryTarget_NoSelectionOrLastTarget_FallsBackToFirstInView()
        {
            var all = new List<string> { "a", "b", "c" };

            Assert.Equal("a", SelectionLogic.ResolvePrimaryTarget(new List<string>(), null, all));
        }

        [Fact]
        public void ResolvePrimaryTarget_NothingAnywhere_ReturnsNull()
        {
            Assert.Null(SelectionLogic.ResolvePrimaryTarget(new List<string>(), null, new List<string>()));
        }

        // --- SelectionSummary ---

        [Theory]
        [InlineData(0)]
        [InlineData(1)]
        public void SelectionSummary_ZeroOrOneSelected_IsEmpty(int selectedCount) =>
            Assert.Equal(string.Empty, SelectionLogic.SelectionSummary(selectedCount));

        [Theory]
        [InlineData(2, "2 selected")]
        [InlineData(3, "3 selected")]
        [InlineData(128, "128 selected")]
        public void SelectionSummary_TwoOrMoreSelected_ReportsTheCount(int selectedCount, string expected) =>
            Assert.Equal(expected, SelectionLogic.SelectionSummary(selectedCount));

        // --- ShouldBecomeSingleTarget ---

        [Theory]
        [InlineData(0, false)]
        [InlineData(1, true)]
        [InlineData(2, false)]
        [InlineData(50, false)]
        public void ShouldBecomeSingleTarget_OnlyTrueForExactlyOneSelected(int selectedCount, bool expected) =>
            Assert.Equal(expected, SelectionLogic.ShouldBecomeSingleTarget(selectedCount));
    }
}
