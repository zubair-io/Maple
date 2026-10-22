using System;
using Maple.WinUI.Generated;

namespace Maple.UI
{
    public static class MuiColorGradeZoneWeightsMath
    {
        private static readonly AdjustmentFieldSpec Blending = Array.Find(AdjustmentFields.All, f => f.Name == "color_grade_blending")!;
        private static readonly AdjustmentFieldSpec Shadow = Array.Find(AdjustmentFields.All, f => f.Name == "color_grade_shadow_edge")!;
        private static readonly AdjustmentFieldSpec Highlight = Array.Find(AdjustmentFields.All, f => f.Name == "color_grade_highlight_edge")!;
        public static readonly double DefaultBlending = Blending.DefaultNumber;
        public static readonly double DefaultShadowEdge = Shadow.DefaultNumber;
        public static readonly double DefaultHighlightEdge = Highlight.DefaultNumber;
        public static readonly double MinShadowEdge = Shadow.Minimum;
        public static readonly double MaxHighlightEdge = Highlight.Maximum;

        /// <summary>Round to 3 decimals, snap to the anchor within 0.005 (as raw-core's resolve_*_edge does), then clamp.</summary>
        public static double SnapEdge(double norm, double min, double max)
        {
            var rounded = Math.Round(norm, 3);
            var snapped = Math.Abs(rounded - DefaultShadowEdge) < 0.005 ? DefaultShadowEdge : rounded;
            return Math.Clamp(snapped, min, max);
        }

        public static double PlotPosition(double edge, double balance) =>
            Math.Pow(Math.Clamp(edge, 0, 1), Math.Pow(2, Math.Clamp(balance, -100, 100) / 100));

        public static double ValueAtPlotPosition(double position, double balance) =>
            Math.Pow(Math.Clamp(position, 0, 1), Math.Pow(2, -Math.Clamp(balance, -100, 100) / 100));

        public static double ClampShadowEdge(double value) =>
            Math.Clamp(value, MinShadowEdge, DefaultShadowEdge);

        public static double ClampHighlightEdge(double value) =>
            Math.Clamp(value, DefaultHighlightEdge, MaxHighlightEdge);

        public static (double Sh, double Mid, double Hi) ComputeWeights(
            double l,
            double balance,
            double blending,
            double shadowEdge,
            double highlightEdge)
        {
            var lClamped = Math.Clamp(l, 0.0, 1.0);
            var balanceExp = Math.Pow(2.0, -Math.Clamp(balance, -100.0, 100.0) / 100.0);
            var lb = Math.Pow(lClamped, balanceExp);
            var b = Math.Clamp(blending, 0.0, 100.0) / 100.0;
            var ls = ClampShadowEdge(shadowEdge);
            var lh = ClampHighlightEdge(highlightEdge);
            var s0 = (1.0 - b) * Math.Max(ls - 0.04, 0.0);
            var s1 = ls;
            var h0 = lh;
            var h1 = 1.0 - (1.0 - b) * Math.Max(1.0 - lh - 0.04, 0.0);
            var wSh = 1.0 - Smoothstep(s0, s1, lb);
            var wHi = Smoothstep(h0, h1, lb);
            var wMid = Math.Max(1.0 - wSh - wHi, 0.0);
            return (wSh, wMid, wHi);
        }

        private static double Smoothstep(double e0, double e1, double x)
        {
            var span = Math.Max(e1 - e0, 1e-5);
            var t = Math.Clamp((x - e0) / span, 0.0, 1.0);
            return t * t * (3.0 - 2.0 * t);
        }
    }
}
