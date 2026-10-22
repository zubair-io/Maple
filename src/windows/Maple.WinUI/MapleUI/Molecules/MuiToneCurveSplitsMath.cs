using System;
using System.Linq;
using Maple.WinUI.Generated;

namespace Maple.UI
{
    public enum ParametricSplitHandle
    {
        Shadow,
        Midtone,
        Highlight,
    }

    /// <summary>
    /// Parametric split-point clamping + active-region window shading math for
    /// the Tone Curve editor (#5039). Mirrors <c>raw_core::stages::tone_curves::parametric</c>
    /// and the Swift/TypeScript ports (<c>ToneCurveSplits.swift</c>,
    /// <c>tone-curve-splits.ts</c>). Plain C#, WinUI-free.
    /// </summary>
    public static class MuiToneCurveSplitsMath
    {
        public static readonly double DefaultShadowSplit = AdjustmentFields.All.Single(field => field.Name == "parametric_shadow_split").DefaultNumber;
        public static readonly double DefaultMidtoneSplit = AdjustmentFields.All.Single(field => field.Name == "parametric_midtone_split").DefaultNumber;
        public static readonly double DefaultHighlightSplit = AdjustmentFields.All.Single(field => field.Name == "parametric_highlight_split").DefaultNumber;
        public const double MinUiGap = 5.0;
        public const double AxisTop = ParametricAxisTuning.Top;

        public static double DefaultValue(ParametricSplitHandle handle) => handle switch
        {
            ParametricSplitHandle.Shadow => DefaultShadowSplit,
            ParametricSplitHandle.Midtone => DefaultMidtoneSplit,
            ParametricSplitHandle.Highlight => DefaultHighlightSplit,
            _ => DefaultMidtoneSplit,
        };

        /// <summary>
        /// Clamp a proposed split-handle drag value against the current triplet
        /// using the #5039 UI authoring bounds:
        /// - shadow: [10, min(70, midtone - 5)]
        /// - midtone: [max(20, shadow + 5), min(80, highlight - 5)]
        /// - highlight: [max(30, midtone + 5), 90]
        /// </summary>
        public static double ClampSplit(
            ParametricSplitHandle handle,
            double proposed,
            double shadow,
            double midtone,
            double highlight)
        {
            var val = double.IsFinite(proposed) ? proposed : DefaultValue(handle);
            switch (handle)
            {
                case ParametricSplitHandle.Shadow:
                {
                    var hi = Math.Max(10.0, Math.Min(70.0, midtone - MinUiGap));
                    return Math.Round(Math.Clamp(val, 10.0, hi));
                }
                case ParametricSplitHandle.Midtone:
                {
                    var lo = Math.Min(80.0, Math.Max(20.0, shadow + MinUiGap));
                    var hi = Math.Max(lo, Math.Min(80.0, highlight - MinUiGap));
                    return Math.Round(Math.Clamp(val, lo, hi));
                }
                case ParametricSplitHandle.Highlight:
                default:
                {
                    var lo = Math.Min(90.0, Math.Max(30.0, midtone + MinUiGap));
                    var hi = Math.Max(lo, 90.0);
                    return Math.Round(Math.Clamp(val, lo, hi));
                }
            }
        }

        public static (double Shadow, double Midtone, double Highlight) OrderedSplits(
            double shadow, double midtone, double highlight)
        {
            const double minGap = 1.0;
            var m = Math.Clamp(midtone, 2.0 * minGap, 100.0 - 2.0 * minGap);
            var s = Math.Clamp(shadow, minGap, m - minGap);
            var h = Math.Clamp(highlight, m + minGap, 100.0 - minGap);
            return (s, m, h);
        }

        public static double[] RegionCentres(double shadow, double midtone, double highlight)
        {
            var (s, m, h) = OrderedSplits(shadow, midtone, highlight);
            return new[]
            {
                s * 0.5,
                (s + m) * 0.5,
                (m + h) * 0.5,
                (h + 100.0) * 0.5,
            };
        }

        public static double[] RegionWindows(
            double p, double shadow, double midtone, double highlight)
        {
            var c = RegionCentres(shadow, midtone, highlight);
            var s01 = Smoothstep(c[0], c[1], p);
            var s12 = Smoothstep(c[1], c[2], p);
            var s23 = Smoothstep(c[2], c[3], p);
            var s3t = Smoothstep(c[3], AxisTop, p);
            return new[] { 1.0 - s01, s01 - s12, s12 - s23, s23 - s3t };
        }

        private static double Smoothstep(double a, double b, double p)
        {
            if (b <= a) return p >= b ? 1.0 : 0.0;
            var t = Math.Clamp((p - a) / (b - a), 0.0, 1.0);
            return t * t * (3.0 - 2.0 * t);
        }
    }
}
