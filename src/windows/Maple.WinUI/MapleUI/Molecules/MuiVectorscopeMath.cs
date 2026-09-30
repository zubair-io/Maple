using System;
using System.Linq;
using System.Collections.Generic;

namespace Maple.UI
{
    /// <summary>One RGB sample (each channel 0..1) for the Vectorscope
    /// scatter plot.</summary>
    public readonly record struct MuiVectorscopeSample(double R, double G, double B);

    /// <summary>
    /// Plain, WinUI-free chroma-projection math behind the Maple.UI
    /// Vectorscope data plot (unified-component-catalog.md §2.6). Graticule
    /// directions are generated from the shared Rec.709 producer; native
    /// density rows are inverted only at bitmap output. Same
    /// split as <see cref="MuiSliderMath"/> — linkable into
    /// Maple.WinUI.Tests without a live Window. Ports
    /// `mui-vectorscope.component.ts`'s legacy BT.601 scatter matrix and plotting
    /// scale exactly (same coefficients, same channel order, same
    /// `radius * 2` chroma scale).
    /// </summary>
    public static class MuiVectorscopeMath
    {
        private static readonly ScopeTargets.Target[] RingStops = ScopeTargets.Values
            .OrderBy(t => NormalizeAngle(Math.Atan2(t.Cr, t.Cb) * 180 / Math.PI)).ToArray();

        public static double NormalizeAngle(double angle) => (angle % 360 + 360) % 360;

        public static double TargetAngle(int target) =>
            Math.Atan2(ScopeTargets.Values[target].Cr, ScopeTargets.Values[target].Cb) * 180 / Math.PI;

        /// <summary>Ring colors interpolate between actual shared-core target directions.</summary>
        public static (double R, double G, double B) RingRgb(double angle)
        {
            angle = NormalizeAngle(angle);
            for (var i = 0; i < RingStops.Length; i++)
            {
                var lower = RingStops[i];
                var upper = RingStops[(i + 1) % RingStops.Length];
                var start = NormalizeAngle(Math.Atan2(lower.Cr, lower.Cb) * 180 / Math.PI);
                var end = NormalizeAngle(Math.Atan2(upper.Cr, upper.Cb) * 180 / Math.PI);
                var span = NormalizeAngle(end - start);
                var distance = NormalizeAngle(angle - start);
                if (distance > span) continue;
                var t = distance / span;
                return (lower.R + (upper.R - lower.R) * t,
                    lower.G + (upper.G - lower.G) * t, lower.B + (upper.B - lower.B) * t);
            }
            return (0, 0, 0);
        }

        /// <summary>Native bins are row-major with Cr increasing with row, opposite
        /// screen Y. Reverse rows exactly once when producing the display bitmap.</summary>
        public static byte[] DensityPixels(IReadOnlyList<uint> bins, int side, byte r, byte g, byte b)
        {
            if (side <= 0 || side > 512 || bins.Count != side * side)
                throw new ArgumentException("Vectorscope density must be a bounded square grid.");
            var pixels = new byte[side * side * 4];
            uint peak = 0;
            foreach (var value in bins) peak = Math.Max(peak, value);
            if (peak == 0) return pixels;
            var logPeak = Math.Log(1.0 + peak);
            for (var row = 0; row < side; row++)
            for (var column = 0; column < side; column++)
            {
                var count = bins[row * side + column];
                if (count == 0) continue;
                var alpha = 0.15 + 0.85 * Math.Log(1.0 + count) / logPeak;
                var index = ((side - row - 1) * side + column) * 4;
                pixels[index] = (byte)Math.Round(b * alpha);
                pixels[index + 1] = (byte)Math.Round(g * alpha);
                pixels[index + 2] = (byte)Math.Round(r * alpha);
                pixels[index + 3] = (byte)Math.Round(255 * alpha);
            }
            return pixels;
        }

        /// <summary>BT.601 RGB (each channel 0..1) to Cb/Cr chroma, each
        /// roughly in [-0.5, 0.5].</summary>
        public static (double Cb, double Cr) ToChroma(double r, double g, double b)
        {
            var cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
            var cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
            return (cb, cr);
        }

        /// <summary>Maps one RGB sample onto the scope's circular
        /// graticule: chroma scaled by <paramref name="radius"/> * 2 (the
        /// web component's own scale factor — the full chroma range spans
        /// the full diameter, not just the radius), centered at (cx, cy),
        /// with Y flipped so positive Cr plots upward (screen Y grows
        /// down).</summary>
        public static (double X, double Y) ToPoint(double r, double g, double b, double cx, double cy, double radius)
        {
            var (cb, cr) = ToChroma(r, g, b);
            return (cx + cb * radius * 2, cy - cr * radius * 2);
        }
    }
}
