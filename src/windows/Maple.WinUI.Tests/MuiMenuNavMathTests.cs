// MuiMenuNavMathTests — the pure keyboard-navigation math shared by the
// Maple.UI overlay menus (Maple.WinUI/MapleUI/Molecules/MuiMenuNavMath.cs,
// wave N3b of the Windows Maple.UI molecules, #3012). No WinUI/live Window
// involved.

using System.Collections.Generic;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiMenuNavMathTests
    {
        [Theory]
        [InlineData(0, 1, 3, 1)]
        [InlineData(2, 1, 3, 0)]   // wraps forward past the end
        [InlineData(0, -1, 3, 2)] // wraps backward past the start
        [InlineData(1, 0, 3, 1)]
        public void WrapIndex_AdvancesWithWraparound(int current, int delta, int count, int expected)
        {
            Assert.Equal(expected, MuiMenuNavMath.WrapIndex(current, delta, count));
        }

        [Fact]
        public void WrapIndex_NonPositiveCount_ReturnsZero()
        {
            Assert.Equal(0, MuiMenuNavMath.WrapIndex(5, 1, 0));
            Assert.Equal(0, MuiMenuNavMath.WrapIndex(5, 1, -1));
        }

        private static readonly IReadOnlyList<int> Selectable = new List<int> { 1, 3, 4 };

        [Fact]
        public void MoveActive_NoPreviousActive_ForwardStartsAtFirst()
        {
            Assert.Equal(1, MuiMenuNavMath.MoveActive(-1, 1, Selectable));
        }

        [Fact]
        public void MoveActive_NoPreviousActive_BackwardStartsAtLast()
        {
            Assert.Equal(4, MuiMenuNavMath.MoveActive(-1, -1, Selectable));
        }

        [Fact]
        public void MoveActive_ForwardFromMiddle_AdvancesToNextSelectable()
        {
            Assert.Equal(3, MuiMenuNavMath.MoveActive(1, 1, Selectable));
        }

        [Fact]
        public void MoveActive_ForwardFromLast_WrapsToFirst()
        {
            Assert.Equal(1, MuiMenuNavMath.MoveActive(4, 1, Selectable));
        }

        [Fact]
        public void MoveActive_BackwardFromFirst_WrapsToLast()
        {
            Assert.Equal(4, MuiMenuNavMath.MoveActive(1, -1, Selectable));
        }

        [Fact]
        public void MoveActive_CurrentNotInSelectable_TreatedAsNoPrevious()
        {
            Assert.Equal(1, MuiMenuNavMath.MoveActive(99, 1, Selectable));
        }

        [Fact]
        public void MoveActive_EmptySelectable_ReturnsNegativeOne()
        {
            Assert.Equal(-1, MuiMenuNavMath.MoveActive(-1, 1, System.Array.Empty<int>()));
        }
    }
}
