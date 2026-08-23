// MuiCollectionGridSelectionTests — the plain/Ctrl/Shift multi-select state
// machine behind the Maple.UI Collection Grid and List View organisms
// (Maple.WinUI/MapleUI/Organisms/MuiCollectionGridSelection.cs, wave N6,
// #3012). No WinUI/live Window involved.

using System.Collections.Generic;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiCollectionGridSelectionTests
    {
        private static readonly IReadOnlyList<string> Ids = new[] { "a", "b", "c", "d", "e" };

        [Fact]
        public void Apply_None_ReplacesSelectionWithTargetOnly()
        {
            var current = new HashSet<string> { "a", "c" };
            var result = MuiCollectionGridSelection.Apply(Ids, current, "a", "d", MuiSelectionModifier.None);
            Assert.Equal(new HashSet<string> { "d" }, result);
        }

        [Fact]
        public void Apply_Toggle_AddsWhenAbsent()
        {
            var current = new HashSet<string> { "a" };
            var result = MuiCollectionGridSelection.Apply(Ids, current, "a", "b", MuiSelectionModifier.Toggle);
            Assert.Equal(new HashSet<string> { "a", "b" }, result);
        }

        [Fact]
        public void Apply_Toggle_RemovesWhenPresent()
        {
            var current = new HashSet<string> { "a", "b" };
            var result = MuiCollectionGridSelection.Apply(Ids, current, "a", "b", MuiSelectionModifier.Toggle);
            Assert.Equal(new HashSet<string> { "a" }, result);
        }

        [Fact]
        public void Apply_Range_SelectsInclusiveSpanForward()
        {
            var current = new HashSet<string> { "b" };
            var result = MuiCollectionGridSelection.Apply(Ids, current, "b", "d", MuiSelectionModifier.Range);
            Assert.Equal(new HashSet<string> { "b", "c", "d" }, result);
        }

        [Fact]
        public void Apply_Range_SelectsInclusiveSpanBackward()
        {
            var current = new HashSet<string> { "d" };
            var result = MuiCollectionGridSelection.Apply(Ids, current, "d", "b", MuiSelectionModifier.Range);
            Assert.Equal(new HashSet<string> { "b", "c", "d" }, result);
        }

        [Fact]
        public void Apply_Range_WithoutAnchor_FallsBackToTargetOnly()
        {
            var current = new HashSet<string>();
            var result = MuiCollectionGridSelection.Apply(Ids, current, null, "c", MuiSelectionModifier.Range);
            Assert.Equal(new HashSet<string> { "c" }, result);
        }

        [Fact]
        public void Apply_Range_WithUnknownAnchor_FallsBackToTargetOnly()
        {
            var current = new HashSet<string>();
            var result = MuiCollectionGridSelection.Apply(Ids, current, "missing", "c", MuiSelectionModifier.Range);
            Assert.Equal(new HashSet<string> { "c" }, result);
        }

        [Fact]
        public void NextAnchor_None_MovesToTarget()
        {
            Assert.Equal("b", MuiCollectionGridSelection.NextAnchor("a", "b", MuiSelectionModifier.None));
        }

        [Fact]
        public void NextAnchor_Toggle_MovesToTarget()
        {
            Assert.Equal("b", MuiCollectionGridSelection.NextAnchor("a", "b", MuiSelectionModifier.Toggle));
        }

        [Fact]
        public void NextAnchor_Range_KeepsExistingAnchor()
        {
            Assert.Equal("a", MuiCollectionGridSelection.NextAnchor("a", "d", MuiSelectionModifier.Range));
        }

        [Fact]
        public void NextAnchor_Range_WithoutExistingAnchor_MovesToTarget()
        {
            Assert.Equal("d", MuiCollectionGridSelection.NextAnchor(null, "d", MuiSelectionModifier.Range));
        }
    }
}
