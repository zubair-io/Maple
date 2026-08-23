// MuiAvatarGroupMathTests — the pure visible/overflow split math behind the
// Maple.UI Avatar Group molecule
// (Maple.WinUI/MapleUI/Molecules/MuiAvatarGroupMath.cs, wave N3b of the
// Windows Maple.UI molecules, #3012). No WinUI/live Window involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiAvatarGroupMathTests
    {
        [Theory]
        [InlineData(5, 3, 3)]
        [InlineData(2, 3, 2)]  // fewer members than the cap — all visible
        [InlineData(0, 3, 0)]
        [InlineData(5, -1, 0)] // a negative cap shows none
        public void VisibleCount_ClampsIntoZeroToTotal(int total, int max, int expected)
        {
            Assert.Equal(expected, MuiAvatarGroupMath.VisibleCount(total, max));
        }

        [Theory]
        [InlineData(5, 3, 2)]
        [InlineData(2, 3, 0)] // under the cap — no overflow badge
        [InlineData(3, 3, 0)] // exactly at the cap — no overflow badge
        public void OverflowCount_ZeroWhenNotExceeded(int total, int max, int expected)
        {
            Assert.Equal(expected, MuiAvatarGroupMath.OverflowCount(total, max));
        }
    }
}
