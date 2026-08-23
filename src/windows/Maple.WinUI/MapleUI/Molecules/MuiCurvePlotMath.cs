using System;
using System.Collections.Generic;
using System.Linq;

namespace Maple.UI
{
    /// <summary>One draggable Curve Plot control point, normalized 0..1 on
    /// both axes.</summary>
    public readonly record struct MuiCurvePoint(double X, double Y);

    /// <summary>One drawn segment of a smoothed curve path, in normalized
    /// 0..1 model space (the caller scales to canvas pixels).</summary>
    public abstract record MuiCurveSegment;

    /// <summary>A straight line to <see cref="To"/> — used only for the
    /// final segment into the last (pinned) point.</summary>
    public sealed record MuiCurveLineTo(MuiCurvePoint To) : MuiCurveSegment;

    /// <summary>A quadratic Bezier curve to <see cref="To"/> using
    /// <see cref="Control"/> as its control point.</summary>
    public sealed record MuiCurveQuadTo(MuiCurvePoint Control, MuiCurvePoint To) : MuiCurveSegment;

    /// <summary>
    /// Plain, WinUI-free drag/hit-test/smoothing math behind the Maple.UI
    /// Curve Plot data plot (unified-component-catalog.md §2.6). Same split
    /// as <see cref="MuiSliderMath"/> — linkable into Maple.WinUI.Tests
    /// without a live Window. Ports `mui-curve-plot.component.ts`'s
    /// hit-test/canvas-conversion/nudge math AND its `draw()` method's
    /// midpoint-quadratic path construction exactly — same "always monotone
    /// in x, no overshoot" stand-in the web port uses in place of a full
    /// Fritsch-Carlson monotone spline (deliberately NOT the app's own
    /// 64-segment monotone-cubic <c>ToneCurveMath</c>, which is a different,
    /// richer curve used by the real tone-curve editor — this is the
    /// generic "Curve Plot" primitive, matching the web/Swift ports' own
    /// lighter-weight choice for that primitive).
    /// </summary>
    public static class MuiCurvePlotMath
    {
        public const double HitRadiusPx = 8;
        public const double NudgeStep = 0.02;

        public static double Clamp01(double v) => Math.Max(0, Math.Min(1, v));

        /// <summary>Normalized model point to canvas pixel point — Y is
        /// flipped (model Y grows up, canvas Y grows down).</summary>
        public static MuiCurvePoint ToCanvasPoint(MuiCurvePoint p, double width, double height) =>
            new(p.X * width, (1 - p.Y) * height);

        /// <summary>Canvas pixel position to a clamped normalized model
        /// point. A non-positive width/height reads as 0 on that axis
        /// (no measured canvas yet) rather than dividing by zero.</summary>
        public static MuiCurvePoint FromCanvasPoint(double x, double y, double width, double height) => new(
            Clamp01(width > 0 ? x / width : 0),
            Clamp01(height > 0 ? 1 - y / height : 0));

        /// <summary>Index of the first point within <see cref="HitRadiusPx"/>
        /// of the given canvas position, or null when none is close enough.
        /// <paramref name="points"/> are normalized model points; the
        /// canvas-space comparison happens internally.</summary>
        public static int? HitTest(IReadOnlyList<MuiCurvePoint> points, double canvasX, double canvasY, double width, double height)
        {
            for (var i = 0; i < points.Count; i++)
            {
                var c = ToCanvasPoint(points[i], width, height);
                var dx = c.X - canvasX;
                var dy = c.Y - canvasY;
                if (Math.Sqrt(dx * dx + dy * dy) <= HitRadiusPx) return i;
            }
            return null;
        }

        /// <summary>Arrow-key nudge of one point by <see cref="NudgeStep"/>,
        /// clamped into [0,1] on both axes. An unrecognized key name
        /// returns the point unchanged.</summary>
        public static MuiCurvePoint Nudge(MuiCurvePoint p, string key) => key switch
        {
            "Up" => p with { Y = Clamp01(p.Y + NudgeStep) },
            "Down" => p with { Y = Clamp01(p.Y - NudgeStep) },
            "Right" => p with { X = Clamp01(p.X + NudgeStep) },
            "Left" => p with { X = Clamp01(p.X - NudgeStep) },
            _ => p,
        };

        /// <summary>Builds the same midpoint-quadratic smoothed path
        /// `mui-curve-plot.component.ts`'s `draw()` traces: points sorted by
        /// X, a quadratic segment from each interior point to the midpoint
        /// of it and its successor (using the interior point itself as the
        /// control point), and a final straight line into the last point.
        /// Fewer than 2 points yields an empty path — <paramref name="start"/>
        /// is the single point (or the default point for an empty list) in
        /// that case, since there's nothing to connect it to.</summary>
        public static IReadOnlyList<MuiCurveSegment> BuildSmoothedPath(
            IReadOnlyList<MuiCurvePoint> points, out MuiCurvePoint start)
        {
            var sorted = points.OrderBy(p => p.X).ToList();
            if (sorted.Count < 2)
            {
                start = sorted.Count == 1 ? sorted[0] : default;
                return Array.Empty<MuiCurveSegment>();
            }

            start = sorted[0];
            var segments = new List<MuiCurveSegment>();
            for (var i = 1; i < sorted.Count - 1; i++)
            {
                var mid = new MuiCurvePoint(
                    (sorted[i].X + sorted[i + 1].X) / 2,
                    (sorted[i].Y + sorted[i + 1].Y) / 2);
                segments.Add(new MuiCurveQuadTo(sorted[i], mid));
            }
            segments.Add(new MuiCurveLineTo(sorted[^1]));
            return segments;
        }
    }
}
