using System;

namespace Maple.UI
{
    /// <summary>Which edge of the anchor the floating panel is flush
    /// against (unified-component-catalog.md §2.4, "Popover" row).</summary>
    public enum MuiPopoverPlacement { Top, Bottom, Left, Right }

    /// <summary>
    /// Plain, WinUI-free placement math behind the Maple.UI Popover
    /// primitive — the anchored-floating-container every overlay menu
    /// (Context/Suggestion/Command/Bubble Menu, Toolbar's overflow) composes.
    /// Same split as <see cref="MuiSliderMath"/>/<see cref="MuiColorWheelMath"/>:
    /// linkable into Maple.WinUI.Tests without a live Window.
    ///
    /// `mui-popover.component.ts` leaves placement math to CSS
    /// (`position: absolute` + a per-placement class); WinUI's
    /// <see cref="Microsoft.UI.Xaml.Controls.Primitives.Popup"/> instead
    /// wants an explicit pixel HorizontalOffset/VerticalOffset, so this is a
    /// small deliberate addition beyond the web port — the offset a
    /// CSS placement class would have produced, computed by hand.
    /// </summary>
    public static class MuiPopoverMath
    {
        public const double DefaultGap = 6;

        /// <summary>The floating panel's top-left position, in the same
        /// coordinate space as the anchor rect, flush against the anchor's
        /// <paramref name="placement"/> edge with <paramref name="gap"/> px
        /// of clearance and centered along the perpendicular axis.</summary>
        public static (double X, double Y) ComputeOffset(
            double anchorX, double anchorY, double anchorWidth, double anchorHeight,
            double panelWidth, double panelHeight,
            MuiPopoverPlacement placement, double gap = DefaultGap)
        {
            return placement switch
            {
                MuiPopoverPlacement.Top =>
                    (anchorX + (anchorWidth - panelWidth) / 2, anchorY - panelHeight - gap),
                MuiPopoverPlacement.Left =>
                    (anchorX - panelWidth - gap, anchorY + (anchorHeight - panelHeight) / 2),
                MuiPopoverPlacement.Right =>
                    (anchorX + anchorWidth + gap, anchorY + (anchorHeight - panelHeight) / 2),
                _ => // Bottom
                    (anchorX + (anchorWidth - panelWidth) / 2, anchorY + anchorHeight + gap),
            };
        }

        /// <summary>Clamps a computed position so the panel's full extent
        /// stays within [0, viewportWidth] x [0, viewportHeight] — an
        /// oversized panel (wider/taller than the viewport) is pinned to 0
        /// rather than shrunk; this primitive never resizes content.</summary>
        public static (double X, double Y) ClampToViewport(
            double x, double y, double panelWidth, double panelHeight,
            double viewportWidth, double viewportHeight)
        {
            var maxX = Math.Max(0, viewportWidth - panelWidth);
            var maxY = Math.Max(0, viewportHeight - panelHeight);
            return (Math.Min(Math.Max(0, x), maxX), Math.Min(Math.Max(0, y), maxY));
        }
    }
}
