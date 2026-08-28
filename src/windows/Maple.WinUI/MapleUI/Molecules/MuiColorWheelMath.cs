using System;

namespace Maple.UI
{
    /// <summary>One Color Wheel reading: hue in degrees [0, 360), saturation
    /// in [0, 100].</summary>
    public readonly record struct MuiColorWheelValue(double Hue, double Saturation);

    /// <summary>
    /// Plain, WinUI-free pointer&lt;-&gt;value math behind the Maple.UI
    /// Color Wheel molecule (unified-component-catalog.md §2.1). Same split
    /// as <see cref="MuiSliderMath"/> — linkable into Maple.WinUI.Tests
    /// without a live Window.
    ///
    /// Mirrors the polar convention the Pro Editor's `color-wheel-math.ts`
    /// ships: hue 0° points right and runs counter-clockwise, puck radius
    /// carries saturation, the centre reads neutral (hue 0, saturation 0).
    /// Kept as its own small pure port (matching
    /// `mui-color-wheel.component.ts`'s split from the app component) so the
    /// pointer math is unit-testable without a live Window. This IS the
    /// geometry truth for the wheel — its web sibling had a
    /// puck-50%-too-high bug caught in the parity build.
    /// </summary>
    public static class MuiColorWheelMath
    {
        public static double Clamp01(double v) => Math.Max(0, Math.Min(1, v));

        /// <summary>Wraps any angle into [0, 360).</summary>
        public static double WrapHue(double degrees)
        {
            var wrapped = degrees % 360;
            return wrapped < 0 ? wrapped + 360 : wrapped;
        }

        /// <summary>Converts a pointer position — normalized to the wheel's
        /// bounds, x right and y DOWN in [0, 1] (screen/control coordinates)
        /// — into a (hue, saturation) reading. <paramref name="fallbackHue"/>
        /// is returned for hue when the pointer lands exactly on the
        /// center (radius 0, where angle is undefined) — pass the control's
        /// current hue so a center click doesn't snap hue to 0.</summary>
        public static MuiColorWheelValue PointerToValue(double nx01, double ny01, double fallbackHue)
        {
            var x = Clamp01(nx01) * 2 - 1;
            var y = (1 - Clamp01(ny01)) * 2 - 1; // flip to y-up
            var radius = Math.Min(1, Math.Sqrt(x * x + y * y));
            var hue = radius == 0 ? fallbackHue : WrapHue(Math.Atan2(y, x) * 180 / Math.PI);
            return new MuiColorWheelValue(Math.Round(hue) % 360, Math.Round(radius * 100));
        }

        /// <summary>Converts a (hue, saturation) reading into the puck's
        /// unit position within the wheel — x right, y DOWN in [0, 1], the
        /// same coordinate convention <see cref="PointerToValue"/> takes.</summary>
        public static (double X01, double Y01) ValueToUnitPosition(double hue, double saturation)
        {
            var radius = Clamp01(Math.Clamp(saturation, 0, 100) / 100.0);
            var rad = WrapHue(hue) * Math.PI / 180;
            var px = (radius * Math.Cos(rad) + 1) / 2;
            var py = (radius * Math.Sin(rad) + 1) / 2;
            return (px, 1 - py); // flip back to y-down
        }
    }
}
