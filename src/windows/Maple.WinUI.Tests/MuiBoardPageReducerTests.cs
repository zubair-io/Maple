// MuiBoardPageReducerTests — the WIP-limit gate layered on top of
// MuiKanbanBoardLogic.MoveCard behind the Maple.UI Board page (Windows
// Pages wave, #3012). No WinUI/live Window involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiBoardPageReducerTests
    {
        private static MuiKanbanCard[] FullColumn() => new[]
        {
            new MuiKanbanCard("1", "doing", "One"),
            new MuiKanbanCard("2", "doing", "Two"),
            new MuiKanbanCard("3", "doing", "Three"),
            new MuiKanbanCard("4", "doing", "Four"),
            new MuiKanbanCard("5", "todo", "Five"),
        };

        [Fact]
        public void CanMoveInto_ColumnUnderLimit_ReturnsTrue()
        {
            Assert.True(MuiBoardPageReducer.CanMoveInto(FullColumn(), "todo", "5"));
        }

        [Fact]
        public void CanMoveInto_ColumnAtLimit_ReturnsFalse()
        {
            Assert.False(MuiBoardPageReducer.CanMoveInto(FullColumn(), "doing", "5"));
        }

        [Fact]
        public void CanMoveInto_MovingCardAlreadyInThatColumn_DoesNotCountItself()
        {
            // Card "1" is already in "doing" (4/4) — reordering it within
            // its own column must not be blocked by its own presence.
            Assert.True(MuiBoardPageReducer.CanMoveInto(FullColumn(), "doing", "1"));
        }

        [Fact]
        public void WipLimit_IsFour()
        {
            Assert.Equal(4, MuiBoardPageReducer.WipLimit);
        }
    }
}
