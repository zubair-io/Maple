namespace Maple.UI
{
    /// <summary>One RGB sample (each channel 0..1) for the Vectorscope
    /// scatter plot.</summary>
    public readonly record struct MuiVectorscopeSample(double R, double G, double B);

    /// <summary>
    /// Plain, WinUI-free chroma-projection math behind the Maple.UI
    /// Vectorscope data plot (unified-component-catalog.md §2.6). Same
    /// split as <see cref="MuiSliderMath"/> — linkable into
    /// Maple.WinUI.Tests without a live Window. Ports
    /// `mui-vectorscope.component.ts`'s inline BT.601 matrix and plotting
    /// scale exactly (same coefficients, same channel order, same
    /// `radius * 2` chroma scale).
    /// </summary>
    public static class MuiVectorscopeMath
    {
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
