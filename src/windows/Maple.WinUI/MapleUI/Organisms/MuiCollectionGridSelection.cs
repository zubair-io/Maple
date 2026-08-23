using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>How a Collection Grid item click combines with the
    /// existing selection — plain modifier-key semantics, no WinUI
    /// dependency (unified-component-catalog.md §4.1, "Collection Grid").
    /// </summary>
    public enum MuiSelectionModifier { None, Toggle, Range }

    /// <summary>
    /// The multi-select state machine behind <see cref="MuiCollectionGrid"/>
    /// and <see cref="MuiListView"/>: plain click replaces the selection
    /// with just the clicked item, Ctrl-click toggles the clicked item in
    /// or out, and Shift-click selects every item between the last
    /// "anchor" (the most recent plain or Ctrl click) and the clicked item,
    /// inclusive, in the grid's own display order. Pure over
    /// <see cref="IReadOnlyList{T}"/> ids so it's unit-testable without a
    /// live Window.
    /// </summary>
    public static class MuiCollectionGridSelection
    {
        public static IReadOnlySet<string> Apply(
            IReadOnlyList<string> orderedIds,
            IReadOnlySet<string> current,
            string? anchorId,
            string targetId,
            MuiSelectionModifier modifier)
        {
            switch (modifier)
            {
                case MuiSelectionModifier.Toggle:
                    var toggled = new HashSet<string>(current);
                    if (!toggled.Remove(targetId)) toggled.Add(targetId);
                    return toggled;

                case MuiSelectionModifier.Range when anchorId != null:
                    var from = IndexOf(orderedIds, anchorId);
                    var to = IndexOf(orderedIds, targetId);
                    if (from < 0 || to < 0) return new HashSet<string> { targetId };
                    var lo = Math.Min(from, to);
                    var hi = Math.Max(from, to);
                    return new HashSet<string>(orderedIds.Skip(lo).Take(hi - lo + 1));

                default:
                    return new HashSet<string> { targetId };
            }
        }

        /// <summary>The next anchor id after a click — Range clicks never
        /// move the anchor (so repeated Shift-clicks keep extending from
        /// the same start), everything else anchors on the clicked item.
        /// </summary>
        public static string NextAnchor(string? currentAnchor, string targetId, MuiSelectionModifier modifier) =>
            modifier == MuiSelectionModifier.Range && currentAnchor != null ? currentAnchor : targetId;

        private static int IndexOf(IReadOnlyList<string> ids, string id)
        {
            for (var i = 0; i < ids.Count; i++)
                if (ids[i] == id) return i;
            return -1;
        }
    }
}
