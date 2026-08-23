// MuiChipRowLogicTests — the pure selection/draft logic behind the Maple.UI
// Chip Row molecule (Maple.WinUI/MapleUI/Molecules/MuiChipRowLogic.cs, wave
// N3a of the Windows Maple.UI molecules, #3012). No WinUI/live Window
// involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiChipRowLogicTests
    {
        [Fact]
        public void IsSelected_MatchingId_ReturnsTrue()
        {
            Assert.True(MuiChipRowLogic.IsSelected("chip-1", "chip-1"));
        }

        [Fact]
        public void IsSelected_DifferentId_ReturnsFalse()
        {
            Assert.False(MuiChipRowLogic.IsSelected("chip-1", "chip-2"));
        }

        [Fact]
        public void IsSelected_NullSelection_NeverMatchesAnyChip()
        {
            Assert.False(MuiChipRowLogic.IsSelected(null, "chip-1"));
        }

        [Fact]
        public void TrimDraft_NormalText_ReturnsTrimmedText()
        {
            Assert.Equal("sunset", MuiChipRowLogic.TrimDraft("  sunset  "));
        }

        [Fact]
        public void TrimDraft_EmptyString_ReturnsNull()
        {
            Assert.Null(MuiChipRowLogic.TrimDraft(""));
        }

        [Fact]
        public void TrimDraft_WhitespaceOnly_ReturnsNull()
        {
            Assert.Null(MuiChipRowLogic.TrimDraft("   "));
        }

        [Fact]
        public void TrimDraft_PreservesInternalWhitespace()
        {
            Assert.Equal("golden hour", MuiChipRowLogic.TrimDraft("  golden hour  "));
        }
    }
}
