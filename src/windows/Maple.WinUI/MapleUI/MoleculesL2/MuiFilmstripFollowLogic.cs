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
    /// axis's measured cell bounds and viewport extent/offset into the same
    /// <see cref="FollowBounds"/>.
    /// </summary>
    public static class MuiFilmstripFollowLogic
    {
        /// <summary>Gap between cells in both strip orientations. Cell
        /// bounds come from layout: 72px is only the thumbnail, not the
        /// full Media Cell including its padding and metadata.</summary>
        public const double CellSpacing = 8;

        /// <summary>The new scroll offset that brings a cell laid out at
        /// <paramref name="itemStart"/> with the measured
        /// <paramref name="itemExtent"/> (chrome and metadata included —
        /// never an assumed uniform thumbnail size) into full view within a
        /// <paramref name="viewportExtent"/>-sized window currently scrolled
        /// to <paramref name="currentOffset"/> — the minimum-distance
        /// scroll: already-visible stays put; a cell off the leading edge
        /// snaps its start to the viewport's leading edge; a cell off the
        /// trailing edge snaps its end to the viewport's trailing edge. A
        /// cell taller/wider than the viewport aligns its leading edge so
        /// repeated layout does not bounce between edges, and an unmeasured
        /// cell or viewport (extent 0) is a no-op.</summary>
        public static double FollowBounds(
            double itemStart, double itemExtent, double viewportExtent, double currentOffset)
        {
            if (itemExtent <= 0 || viewportExtent <= 0) return currentOffset;
            var itemEnd = itemStart + itemExtent;

            if (itemExtent >= viewportExtent) return itemStart;
            if (itemStart < currentOffset) return itemStart;
            if (itemEnd > currentOffset + viewportExtent) return itemEnd - viewportExtent;
            return currentOffset;
        }
    }
}
