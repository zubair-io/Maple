using System;

namespace Maple.UI
{
    public static class MuiColorGradeZoneWeightsMath
    {
        public const double DefaultBlending = 100.0;
        public const double DefaultShadowEdge = 0.564622;
        public const double DefaultHighlightEdge = 0.564622;
        public const double MinShadowEdge = 0.10;
        public const double MaxHighlightEdge = 0.90;

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
            var b = Math.Clamp(balance, -100.0, 100.0) / 100.0;
            var lMid = DefaultShadowEdge - 0.18 * b;
            var lLow = ClampShadowEdge(shadowEdge);
            var lHigh = ClampHighlightEdge(highlightEdge);
            var w = Math.Clamp(blending, 0.0, 100.0) / 100.0;
            var sh0 = Math.Max(lLow * (1.0 - w), 0.0);
            var sh1 = Math.Max(Math.Min(lLow + (lMid - lLow) * w, 1.0), sh0 + 1e-4);
            var hi0 = Math.Min(Math.Max(lMid + (lHigh - lMid) * (1.0 - w), 0.0), 1.0 - 1e-4);
            var hi1 = Math.Max(Math.Min(lHigh + (1.0 - lHigh) * w, 1.0), hi0 + 1e-4);
            var wSh = 1.0 - Smoothstep(sh0, sh1, lClamped);
            var wHi = Smoothstep(hi0, hi1, lClamped);
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
