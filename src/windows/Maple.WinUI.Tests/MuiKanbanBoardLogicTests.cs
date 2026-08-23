// MuiKanbanBoardLogicTests — the card-move logic behind the Maple.UI
// Kanban Board organism (Maple.WinUI/MapleUI/Organisms/MuiKanbanBoardLogic.cs,
// wave N6, #3012). No WinUI/live Window involved.

using System.Linq;
using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiKanbanBoardLogicTests
    {
        private static MuiKanbanCard[] Board() => new[]
        {
            new MuiKanbanCard("1", "todo", "One"),
            new MuiKanbanCard("2", "todo", "Two"),
            new MuiKanbanCard("3", "doing", "Three"),
            new MuiKanbanCard("4", "done", "Four"),
        };

        [Fact]
        public void MoveCard_WithinSameColumn_Reorders()
        {
            var result = MuiKanbanBoardLogic.MoveCard(Board(), "1", "todo", 1);
            var todoIds = MuiKanbanBoardLogic.CardsInColumn(result, "todo").Select(c => c.Id).ToList();
            Assert.Equal(new[] { "2", "1" }, todoIds);
        }

        [Fact]
        public void MoveCard_AcrossColumns_UpdatesColumnId()
        {
            var result = MuiKanbanBoardLogic.MoveCard(Board(), "1", "doing", 0);
            var moved = result.First(c => c.Id == "1");
            Assert.Equal("doing", moved.ColumnId);
        }

        [Fact]
        public void MoveCard_AcrossColumns_LeavesSourceColumnOrder()
        {
            var result = MuiKanbanBoardLogic.MoveCard(Board(), "1", "doing", 0);
            var todoIds = MuiKanbanBoardLogic.CardsInColumn(result, "todo").Select(c => c.Id).ToList();
            Assert.Equal(new[] { "2" }, todoIds);
        }

        [Fact]
        public void MoveCard_AcrossColumns_InsertsAtRequestedIndex()
        {
            var result = MuiKanbanBoardLogic.MoveCard(Board(), "4", "doing", 0);
            var doingIds = MuiKanbanBoardLogic.CardsInColumn(result, "doing").Select(c => c.Id).ToList();
            Assert.Equal(new[] { "4", "3" }, doingIds);
        }

        [Fact]
        public void MoveCard_ClampsIndexBelowZero()
        {
            var result = MuiKanbanBoardLogic.MoveCard(Board(), "2", "todo", -5);
            var todoIds = MuiKanbanBoardLogic.CardsInColumn(result, "todo").Select(c => c.Id).ToList();
            Assert.Equal(new[] { "2", "1" }, todoIds);
        }

        [Fact]
        public void MoveCard_ClampsIndexAboveCount()
        {
            var result = MuiKanbanBoardLogic.MoveCard(Board(), "1", "todo", 99);
            var todoIds = MuiKanbanBoardLogic.CardsInColumn(result, "todo").Select(c => c.Id).ToList();
            Assert.Equal(new[] { "2", "1" }, todoIds);
        }

        [Fact]
        public void MoveCard_UnknownCardId_ReturnsUnchanged()
        {
            var board = Board();
            var result = MuiKanbanBoardLogic.MoveCard(board, "missing", "done", 0);
            Assert.Equal(board, result);
        }

        [Fact]
        public void MoveCard_PreservesOverallColumnGrouping()
        {
            var result = MuiKanbanBoardLogic.MoveCard(Board(), "4", "todo", 1);
            Assert.Equal(new[] { "1", "4", "2", "3" }, result.Select(c => c.Id));
        }
    }
}
