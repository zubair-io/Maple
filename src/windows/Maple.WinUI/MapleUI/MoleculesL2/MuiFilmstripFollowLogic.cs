using System.Collections.Generic;

namespace Maple.UI
{
    /// <summary>
    /// Plain, WinUI-free active-follow math behind the Maple.UI Filmstrip
    /// Row/Rail molecules (unified-component-catalog.md §3, "Filmstrip
    /// Row"/"Filmstrip Rail" rows: "Selection follows `activeId`"). Same
    /// split as <see cref="MuiPopoverMath"/>/<see cref="MuiSliderMath"/> —
    /// linkable into Maple.WinUI.Tests without a live Window or
    /// <c>ScrollViewer</c>.
    ///
    /// Axis-agnostic on purpose: Filmstrip Row scrolls horizontally,
    /// Filmstrip Rail vertically, but "keep the active cell fully inside
    /// the viewport, scrolling the minimum distance to do it" is the same
    /// one-dimensional problem either way — both controls pass their own
    /// axis's extent/offset into the same <see cref="FollowOffset"/>.
    /// </summary>
    public static class MuiFilmstripFollowLogic
    {
        /// <summary>Index of <paramref name="activeId"/> within
        /// <paramref name="ids"/>, or -1 when absent/null (no active item
        /// yet, or an id that isn't in the current list).</summary>
        public static int IndexOf(IReadOnlyList<string> ids, string? activeId)
        {
            if (activeId is null) return -1;
            for (var i = 0; i < ids.Count; i++)
                if (ids[i] == activeId) return i;
            return -1;
        }

        /// <summary>The new scroll offset that brings the cell at
        /// <paramref name="index"/> (each <paramref name="itemExtent"/>
        /// wide/tall, <paramref name="spacing"/> apart, uniform strip) into
        /// full view within a <paramref name="viewportExtent"/>-sized
        /// window currently scrolled to <paramref name="currentOffset"/> —
        /// the minimum-distance scroll: already-visible stays put; a cell
        /// off the leading edge snaps its start to the viewport's leading
        /// edge; a cell off the trailing edge snaps its end to the
        /// viewport's trailing edge. A negative <paramref name="index"/>
        /// (no active item) is a no-op, same as an unchanged offset.</summary>
        public static double FollowOffset(
            int index, double itemExtent, double spacing, double viewportExtent, double currentOffset)
        {
            if (index < 0) return currentOffset;

            var itemStart = index * (itemExtent + spacing);
            var itemEnd = itemStart + itemExtent;

            if (itemStart < currentOffset) return itemStart;
            if (itemEnd > currentOffset + viewportExtent) return itemEnd - viewportExtent;
            return currentOffset;
        }
    }
}
