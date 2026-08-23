namespace Maple.UI
{
    /// <summary>One 2-D Pad reading, in the control's own axis units.</summary>
    public readonly record struct MuiPad2DValue(double X, double Y);

    /// <summary>
    /// Plain, WinUI-free pointer&lt;-&gt;value math behind the Maple.UI 2-D
    /// Pad molecule (unified-component-catalog.md §2.1, "primitive plot —
    /// no atom dependency"). Same split as <see cref="MuiSliderMath"/> —
    /// linkable into Maple.WinUI.Tests without a live Window.
    ///
    /// Same y-up convention as <see cref="MuiColorWheelMath"/> (up = higher
    /// Y, matching the Color Wheel's polar math this molecule sits beside in
    /// the catalog) applied to a plain rectangular X/Y range instead of a
    /// polar hue/saturation one.
    /// </summary>
    public static class MuiPad2DMath
    {
        /// <summary>Converts a pointer position — normalized to the pad's
        /// bounds, x right and y DOWN in [0, 1] — into an (x, y) reading
        /// scaled to [minX, maxX] x [minY, maxY]. Degenerate ranges
        /// (min == max on an axis) pin that axis to its single value.</summary>
        public static MuiPad2DValue PointerToValue(
            double nx01, double ny01, double minX, double maxX, double minY, double maxY)
        {
            var cx = MuiSliderMath.Clamp(nx01, 0, 1);
            var cy = MuiSliderMath.Clamp(ny01, 0, 1);
            var x = maxX.Equals(minX) ? minX : minX + cx * (maxX - minX);
            // y is DOWN in pointer space but UP in value space, so invert.
            var y = maxY.Equals(minY) ? minY : maxY - cy * (maxY - minY);
            return new MuiPad2DValue(x, y);
        }

        /// <summary>Converts an (x, y) reading into the puck's unit
        /// position within the pad — x right, y DOWN in [0, 1], the same
        /// coordinate convention <see cref="PointerToValue"/> takes.
        /// Degenerate ranges (min == max on an axis) center the puck on
        /// that axis.</summary>
        public static (double X01, double Y01) ValueToUnitPosition(
            double x, double y, double minX, double maxX, double minY, double maxY)
        {
            var nx = maxX.Equals(minX) ? 0.5 : (x - minX) / (maxX - minX);
            var ny = maxY.Equals(minY) ? 0.5 : (y - minY) / (maxY - minY);
            return (MuiSliderMath.Clamp(nx, 0, 1), 1 - MuiSliderMath.Clamp(ny, 0, 1));
        }
    }
}
