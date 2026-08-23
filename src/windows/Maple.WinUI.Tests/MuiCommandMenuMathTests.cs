// MuiCommandMenuMathTests — the pure filter/clamp math behind the Maple.UI
// Command Menu molecule (Maple.WinUI/MapleUI/Molecules/MuiCommandMenuMath.cs,
// wave N3b of the Windows Maple.UI molecules, #3012). No WinUI/live Window
// involved.

using System.Collections.Generic;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiCommandMenuMathTests
    {
        private static readonly List<MuiCommandItem> Commands = new()
        {
            new("export", "Export selected…"),
            new("batch-rename", "Batch rename…"),
            new("reveal", "Reveal in Finder"),
        };

        [Fact]
        public void Filter_EmptyQuery_ReturnsEveryCommand()
        {
            Assert.Equal(3, MuiCommandMenuMath.Filter(Commands, "").Count);
        }

        [Fact]
        public void Filter_WhitespaceQuery_ReturnsEveryCommand()
        {
            Assert.Equal(3, MuiCommandMenuMath.Filter(Commands, "   ").Count);
        }

        [Fact]
        public void Filter_SubstringMatch_IsCaseInsensitive()
        {
            var result = MuiCommandMenuMath.Filter(Commands, "REVEAL");
            Assert.Single(result);
            Assert.Equal("reveal", result[0].Id);
        }

        [Fact]
        public void Filter_MatchesMidWord()
        {
            var result = MuiCommandMenuMath.Filter(Commands, "rename");
            Assert.Single(result);
            Assert.Equal("batch-rename", result[0].Id);
        }

        [Fact]
        public void Filter_NoMatch_ReturnsEmpty()
        {
            Assert.Empty(MuiCommandMenuMath.Filter(Commands, "zzz"));
        }

        [Theory]
        [InlineData(0, 3, 0)]
        [InlineData(2, 3, 2)]
        [InlineData(5, 3, 2)]  // above range clamps to last
        [InlineData(-1, 3, 0)] // below range clamps to first
        [InlineData(0, 0, -1)] // nothing to highlight
        public void ClampActiveIndex_BoundsIntoRange(int activeIndex, int count, int expected)
        {
            Assert.Equal(expected, MuiCommandMenuMath.ClampActiveIndex(activeIndex, count));
        }
    }
}
