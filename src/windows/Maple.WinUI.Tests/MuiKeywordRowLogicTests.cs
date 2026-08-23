// MuiKeywordRowLogicTests — the draft-trim and add/remove-list transform
// behind the Maple.UI Keyword Row molecule
// (Maple.WinUI/MapleUI/MoleculesL2/MuiKeywordRowLogic.cs, wave N4 of the
// Windows Maple.UI molecules L2, #3012). No WinUI/live Window involved.

using System.Collections.Generic;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiKeywordRowLogicTests
    {
        [Fact]
        public void TrimDraft_NormalText_ReturnsTrimmedText()
        {
            Assert.Equal("sunset", MuiKeywordRowLogic.TrimDraft("  sunset  "));
        }

        [Fact]
        public void TrimDraft_WhitespaceOnly_ReturnsNull()
        {
            Assert.Null(MuiKeywordRowLogic.TrimDraft("   "));
        }

        [Fact]
        public void Add_NewLabel_AppendsChipWithIdEqualToLabel()
        {
            var chips = new List<MuiChip> { new("water", "Water") };

            var next = MuiKeywordRowLogic.Add(chips, "dusk");

            Assert.Equal(2, next.Count);
            Assert.Equal(new MuiChip("dusk", "dusk"), next[1]);
        }

        [Fact]
        public void Add_DuplicateLabel_LeavesListUnchanged()
        {
            var chips = new List<MuiChip> { new("water", "Water") };

            var next = MuiKeywordRowLogic.Add(chips, "water");

            Assert.Single(next);
        }

        [Fact]
        public void Remove_MatchingId_DropsThatChipOnly()
        {
            var chips = new List<MuiChip> { new("water", "Water"), new("dusk", "Dusk") };

            var next = MuiKeywordRowLogic.Remove(chips, "water");

            Assert.Single(next);
            Assert.Equal("dusk", next[0].Id);
        }

        [Fact]
        public void Remove_UnknownId_LeavesListUnchanged()
        {
            var chips = new List<MuiChip> { new("water", "Water") };

            var next = MuiKeywordRowLogic.Remove(chips, "nope");

            Assert.Single(next);
        }
    }
}
