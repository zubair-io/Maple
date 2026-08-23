using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>One column header on a Kanban Board.</summary>
    public sealed record MuiKanbanColumn(string Id, string Title);

    /// <summary>One card on a Kanban Board. A card's position within its
    /// column is its relative order among same-<see cref="ColumnId"/>
    /// cards in the owning board's flat card list — there's no separate
    /// index field to keep in sync.</summary>
    public sealed record MuiKanbanCard(string Id, string ColumnId, string Title, string? Subtitle = null);

    /// <summary>
    /// The card-move logic behind <see cref="MuiKanbanBoard"/>: given the
    /// board's full flat card list, moves one card to a target column at a
    /// target index, preserving every other column's own card order and
    /// the boards's overall column order. Pure over plain records — unit
    /// tested without a live Window; the control itself only computes
    /// which column/index a drop lands on (hit-testing pointer position
    /// against measured column bounds) and defers the actual reordering
    /// here.
    /// </summary>
    public static class MuiKanbanBoardLogic
    {
        public static IReadOnlyList<MuiKanbanCard> MoveCard(
            IReadOnlyList<MuiKanbanCard> cards, string cardId, string targetColumnId, int targetIndex)
        {
            var moving = cards.FirstOrDefault(c => c.Id == cardId);
            if (moving is null) return cards;

            var remaining = cards.Where(c => c.Id != cardId).ToList();
            var columnOrder = cards.Select(c => c.ColumnId).Distinct().ToList();
            if (!columnOrder.Contains(targetColumnId)) columnOrder.Add(targetColumnId);

            var result = new List<MuiKanbanCard>();
            foreach (var columnId in columnOrder)
            {
                var bucket = remaining.Where(c => c.ColumnId == columnId).ToList();
                if (columnId == targetColumnId)
                {
                    var index = targetIndex < 0 ? 0 : targetIndex > bucket.Count ? bucket.Count : targetIndex;
                    bucket.Insert(index, moving with { ColumnId = targetColumnId });
                }
                result.AddRange(bucket);
            }
            return result;
        }

        public static IReadOnlyList<MuiKanbanCard> CardsInColumn(IReadOnlyList<MuiKanbanCard> cards, string columnId) =>
            cards.Where(c => c.ColumnId == columnId).ToList();
    }
}
