using System;
using System.Collections.Generic;

namespace Maple.UI
{
    /// <summary>
    /// Plain, WinUI-free bar-height/lane-layout math shared by the Maple.UI
    /// Histogram, Waveform, and Parade data plots (unified-component-
    /// catalog.md §2.6). Same split as <see cref="MuiSliderMath"/> —
    /// linkable into Maple.WinUI.Tests without a live Window (drawing the
    /// actual bars is still per-control, since each plot scales/colors
    /// differently — Histogram is peak-relative and overlapping, Parade is
    /// per-lane 0..1-clamped and gapped — this only holds the math both
    /// share).
    /// </summary>
    public static class MuiPlotMath
    {
        public static double ClampUnit(double value) => Math.Max(0, Math.Min(1, value));

        /// <summary>The tallest single sample across every channel, floored
        /// at 1 so a silent/empty frame never divides by zero. Ports the
        /// shared `peak = Math.max(peak, value)` reduction in
        /// mui-histogram.component.ts.</summary>
        public static double Peak(IEnumerable<IReadOnlyList<double>> channels)
        {
            double peak = 1;
            foreach (var values in channels)
                foreach (var value in values)
                    if (value > peak) peak = value;
            return peak;
        }

        /// <summary>One bar's 0..1 height fraction relative to
        /// <paramref name="peak"/>. Ports `drawVerticalBars`'s
        /// `(value) => value / peak` mapper. A non-positive peak (should
        /// never happen given <see cref="Peak"/>'s floor, but defensive for
        /// a caller-supplied peak) reads as 0 rather than dividing by
        /// zero/going negative.</summary>
        public static double BarHeightFraction(double value, double peak) => peak <= 0 ? 0 : value / peak;

        /// <summary>The width of each of <paramref name="laneCount"/> equal
        /// lanes spanning <paramref name="width"/> px with
        /// <paramref name="gap"/> px between each — Parade's side-by-side
        /// channel layout. A non-positive lane count returns the full width
        /// (nothing to divide).</summary>
        public static double LaneWidth(int laneCount, double width, double gap) =>
            laneCount <= 0 ? width : (width - gap * (laneCount - 1)) / laneCount;

        /// <summary>Left edge (in plot-local px) of lane
        /// <paramref name="laneIndex"/>.</summary>
        public static double LaneX(int laneIndex, int laneCount, double width, double gap) =>
            laneIndex * (LaneWidth(laneCount, width, gap) + gap);
    }
}
