using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>Plain, WinUI-free decision logic behind
    /// <c>MuiPageBoard</c>'s cross-organism wiring (#3012) — a WIP-limit
    /// gate on top of the already-tested <see cref="MuiKanbanBoardLogic.MoveCard"/>.
    /// The board page rejects a drop into a column that's already at
    /// capacity (a real culling-workflow constraint: "Editing" only holds
    /// so many photos being actively worked at once) rather than
    /// silently accepting an unbounded pile.</summary>
    public static class MuiBoardPageReducer
    {
        public const int WipLimit = 4;

        /// <summary>True when <paramref name="columnId"/> has room for one
        /// more card that isn't already <paramref name="movingCardId"/>
        /// itself (moving a card within its own column, or reordering,
        /// must never be blocked by its own presence).</summary>
        public static bool CanMoveInto(IReadOnlyList<MuiKanbanCard> cards, string columnId, string movingCardId)
        {
            var occupied = cards.Count(c => c.ColumnId == columnId && c.Id != movingCardId);
            return occupied < WipLimit;
        }
    }
}
