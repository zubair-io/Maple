using System.Collections.Generic;

namespace Maple.UI
{
    /// <summary>One tick mark on a Drag Bar track: its position as a [0,100]
    /// percentage, and whether it's the emphasized center tick.</summary>
    public readonly record struct MuiDragBarTick(double Pct, bool Emphasized);

    /// <summary>
    /// Plain, WinUI-free tick layout and value/position math behind the
    /// Maple.UI Drag Bar molecule (unified-component-catalog.md §2.1). Same
    /// split as <see cref="MuiSliderMath"/> — linkable into
    /// Maple.WinUI.Tests without a live Window.
    ///
    /// Ports `mui-drag-bar.component.ts`: 21 evenly spaced ticks, the
    /// center one emphasized, and click-to-value / relative-drag math
    /// identical to the web molecule's `valueAtX`.
    /// </summary>
    public static class MuiDragBarMath
    {
        public const int DefaultTickCount = 21;
        public const int DefaultCenterIndex = 10;

        /// <summary>Builds <paramref name="count"/> evenly spaced ticks
        /// across the track (0%..100%), with the middle tick (index
        /// count/2, integer division) flagged as emphasized — mirrors
        /// `buildTicks()`.</summary>
        public static IReadOnlyList<MuiDragBarTick> BuildTicks(int count = DefaultTickCount)
        {
            var centerIndex = count / 2;
            var ticks = new List<MuiDragBarTick>(count);
            for (var i = 0; i < count; i++)
            {
                var pct = count <= 1 ? 0 : (double)i / (count - 1) * 100.0;
                ticks.Add(new MuiDragBarTick(pct, i == centerIndex));
            }
            return ticks;
        }

        /// <summary>Snaps a pointer's x-offset within a <paramref name="barWidth"/>-wide
        /// track to a whole-number value in [min, max] — ports `valueAtX`.
        /// A zero/negative bar width returns <paramref name="fallback"/>
        /// (the control's current value, unchanged) rather than dividing by
        /// zero.</summary>
        public static double ValueAtPosition(double x, double barWidth, double min, double max, double fallback)
        {
            if (barWidth <= 0) return fallback;
            var pct = x / barWidth;
            var raw = min + pct * (max - min);
            return MuiSliderMath.Clamp(System.Math.Round(raw), min, max);
        }

        /// <summary>Marker position as a [0,100] percentage — shares
        /// <see cref="MuiSliderMath.PercentInRange"/>, centered (50%)
        /// fallback for the degenerate min == max case.</summary>
        public static double MarkerPct(double value, double min, double max) =>
            MuiSliderMath.PercentInRange(value, min, max, fallbackPct: 50);
    }
}
