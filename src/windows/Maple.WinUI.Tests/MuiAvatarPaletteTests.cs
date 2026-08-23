// MuiAvatarPaletteTests — the pure name-hash palette pick and initials
// extraction behind the Maple.UI Avatar atom (Maple.WinUI/MapleUI/Atoms/
// MuiAvatarPalette.cs, wave 2 of the Windows Maple.UI atoms, #3012). No
// WinUI/live Window involved — this is the one part of that atom CI can
// actually verify.

using Maple.UI.Atoms;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiAvatarPaletteTests
    {
        [Fact]
        public void PaletteIndex_SameNameTwice_ReturnsTheSameIndex()
        {
            // The whole point of using a stable hash instead of
            // string.GetHashCode() (randomized per process by .NET Core) —
            // same person, same swatch, every launch.
            var first = MuiAvatarPalette.PaletteIndex("Ada Lovelace", 6);
            var second = MuiAvatarPalette.PaletteIndex("Ada Lovelace", 6);
            Assert.Equal(first, second);
        }

        [Fact]
        public void PaletteIndex_IsWithinPaletteBounds()
        {
            for (var i = 0; i < 50; i++)
            {
                var index = MuiAvatarPalette.PaletteIndex($"Person {i}", 6);
                Assert.InRange(index, 0, 5);
            }
        }

        [Fact]
        public void PaletteIndex_KnownValue_MatchesFnv1aByHand()
        {
            // Pins the exact FNV-1a formula (not just "deterministic") so a
            // future refactor that accidentally changes the hash algorithm
            // — and silently reassigns everyone's avatar color — fails here.
            const uint offsetBasis = 2166136261;
            const uint prime = 16777619;
            var expectedHash = offsetBasis;
            foreach (var ch in "Ada")
            {
                expectedHash ^= ch;
                expectedHash *= prime;
            }

            Assert.Equal(expectedHash, MuiAvatarPalette.StableHash("Ada"));
            Assert.Equal((int)(expectedHash % 6), MuiAvatarPalette.PaletteIndex("Ada", 6));
        }

        [Fact]
        public void PaletteIndex_EmptyOrWhitespaceName_ReturnsSlotZero()
        {
            Assert.Equal(0, MuiAvatarPalette.PaletteIndex("", 6));
            Assert.Equal(0, MuiAvatarPalette.PaletteIndex("   ", 6));
        }

        [Fact]
        public void Initials_TwoWordName_ReturnsFirstAndLastInitial()
        {
            Assert.Equal("AL", MuiAvatarPalette.Initials("Ada Lovelace"));
        }

        [Fact]
        public void Initials_ThreeWordName_ReturnsFirstAndLastWordInitials_NotMiddle()
        {
            Assert.Equal("GH", MuiAvatarPalette.Initials("Grace Brewster Hopper"));
        }

        [Fact]
        public void Initials_SingleWordName_ReturnsOneLetter()
        {
            Assert.Equal("C", MuiAvatarPalette.Initials("Cher"));
        }

        [Fact]
        public void Initials_LowercaseName_IsUppercased()
        {
            Assert.Equal("AL", MuiAvatarPalette.Initials("ada lovelace"));
        }

        [Fact]
        public void Initials_EmptyName_ReturnsEmptyString()
        {
            Assert.Equal(string.Empty, MuiAvatarPalette.Initials(""));
        }

        [Fact]
        public void Initials_WhitespaceOnlyName_ReturnsEmptyString()
        {
            Assert.Equal(string.Empty, MuiAvatarPalette.Initials("   "));
        }

        [Fact]
        public void Initials_ExtraInternalWhitespace_IsIgnored()
        {
            Assert.Equal("AL", MuiAvatarPalette.Initials("  Ada   Lovelace  "));
        }
    }
}
