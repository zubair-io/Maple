using System;
using System.IO;
using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.UI.Xaml.Shapes;
using Windows.UI;

namespace Maple.WinUI.Controls
{
    /// <summary>One color-grading wheel: hue disc + saturation fade + puck.
    /// Ports the web's ColorWheelComponent (color-wheel-math.ts): hue 0 points
    /// right and runs counter-clockwise, radius carries saturation, the centre
    /// reads neutral. Emits absolute (hue, saturation) on pointer interaction;
    /// double-tap emits a reset (hue 0, sat 0 — the identity state).</summary>
    public sealed class ColorWheelControl : Grid
    {
        private const int BitmapPx = 236;             // 2x the ~118px cell for crispness
        private static readonly Color Surface = Color.FromArgb(0xFF, 0x1A, 0x19, 0x17);

        private readonly Image _disc;
        private readonly Ellipse _puck;
        private bool _tracking;
        private double _hue;
        private double _saturation;

        /// <summary>Absolute wheel change from a drag/click: (hue°, saturation 0-100).</summary>
        public event Action<double, double>? WheelChanged;
        /// <summary>Double-tap reset request (identity: hue 0, sat 0).</summary>
        public event Action? ResetRequested;

        public ColorWheelControl()
        {
            _disc = new Image
            {
                Source = BuildDiscBitmap(),
                Stretch = Stretch.Uniform,
            };
            _puck = new Ellipse
            {
                Width = 12,
                Height = 12,
                Stroke = new SolidColorBrush(Microsoft.UI.Colors.White),
                StrokeThickness = 2,
                Fill = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                IsHitTestVisible = false,
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Top,
            };
            Children.Add(_disc);
            Children.Add(_puck);

            PointerPressed += OnPointerPressed;
            PointerMoved += OnPointerMoved;
            PointerReleased += OnPointerReleased;
            PointerCanceled += OnPointerReleased;
            PointerCaptureLost += (_, _) => _tracking = false;
            DoubleTapped += (_, _) => ResetRequested?.Invoke();
            SizeChanged += (_, _) => PositionPuck();
        }

        /// <summary>Move the puck without emitting (model → view sync).</summary>
        public void SetValue(double hue, double saturation)
        {
            _hue = hue;
            _saturation = saturation;
            PositionPuck();
        }

        // --- pointer → (hue, sat): exact port of posToWheel/applyPointer ---

        private void ApplyPointer(PointerRoutedEventArgs e)
        {
            if (ActualWidth <= 0 || ActualHeight <= 0)
                return;
            var pt = e.GetCurrentPoint(this).Position;
            var x = Math.Clamp(pt.X / ActualWidth, 0, 1);
            var y = 1 - Math.Clamp(pt.Y / ActualHeight, 0, 1);   // flip to y-up
            var dx = x * 2 - 1;
            var dy = y * 2 - 1;
            var radius = Math.Min(1, Math.Sqrt(dx * dx + dy * dy));
            var hue = radius == 0 ? 0 : WrapHue(Math.Atan2(dy, dx) * 180 / Math.PI);
            WheelChanged?.Invoke(Math.Round(hue) % 360, Math.Round(radius * 100));
        }

        private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
        {
            if (!e.GetCurrentPoint(this).Properties.IsLeftButtonPressed)
                return;
            _tracking = CapturePointer(e.Pointer);
            ApplyPointer(e);
            e.Handled = true;
        }

        private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (!_tracking)
                return;
            ApplyPointer(e);
            e.Handled = true;
        }

        private void OnPointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (!_tracking)
                return;
            _tracking = false;
            ReleasePointerCapture(e.Pointer);
            e.Handled = true;
        }

        private static double WrapHue(double hue)
        {
            var h = hue % 360;
            return h < 0 ? h + 360 : h;
        }

        // --- puck placement: wheelToPos ---

        private void PositionPuck()
        {
            if (ActualWidth <= 0 || ActualHeight <= 0)
                return;
            var radius = Math.Clamp(_saturation, 0, 100) / 100;
            var rad = WrapHue(_hue) * Math.PI / 180;
            var px = (radius * Math.Cos(rad) + 1) / 2;
            var py = (radius * Math.Sin(rad) + 1) / 2;
            _puck.Margin = new Thickness(
                px * ActualWidth - 6, (1 - py) * ActualHeight - 6, 0, 0);
        }

        // --- disc bitmap: conic hue ring + radial surface fade + rim ---

        private static WriteableBitmap? _sharedDisc;

        private static WriteableBitmap BuildDiscBitmap()
        {
            if (_sharedDisc != null)
                return _sharedDisc;
            var bmp = new WriteableBitmap(BitmapPx, BitmapPx);
            var pixels = new byte[BitmapPx * BitmapPx * 4];
            var half = BitmapPx / 2.0;
            var aa = 1.5 / half;                       // ~1.5px anti-alias band
            for (var yPix = 0; yPix < BitmapPx; yPix++)
            {
                for (var xPix = 0; xPix < BitmapPx; xPix++)
                {
                    var dx = (xPix + 0.5) / half - 1;
                    var dy = 1 - (yPix + 0.5) / half;   // y-up, matching the math
                    var r = Math.Sqrt(dx * dx + dy * dy);
                    var o = (yPix * BitmapPx + xPix) * 4;
                    if (r > 1)
                    {
                        var edge = Math.Clamp((r - 1) / aa, 0, 1);
                        if (edge >= 1)
                            continue;                   // fully outside: transparent
                        // partial rim pixel — rim color faded out
                        WritePixel(pixels, o, RimColor(), 1 - edge);
                        continue;
                    }
                    var hue = WrapHue(Math.Atan2(dy, dx) * 180 / Math.PI);
                    var (hr, hg, hb) = HslToRgb(hue, 1.0, 0.5);
                    // radial fade: surface opaque at centre → transparent at 72%
                    // of the CSS gradient extent, which is farthest-corner for a
                    // square box: 0.72 · √2 ≈ 1.018 of the disc radius.
                    var fade = Math.Clamp(1 - r / (0.72 * Math.Sqrt(2)), 0, 1);
                    var cr = (byte)(hr + (Surface.R - hr) * fade);
                    var cg = (byte)(hg + (Surface.G - hg) * fade);
                    var cb = (byte)(hb + (Surface.B - hb) * fade);
                    // 0.5px border ring: white 12% over the rim
                    var rim = Math.Clamp((r - (1 - 2.0 / half)) * half / 2.0, 0, 1) * 0.12;
                    cr = (byte)(cr + (255 - cr) * rim);
                    cg = (byte)(cg + (255 - cg) * rim);
                    cb = (byte)(cb + (255 - cb) * rim);
                    pixels[o] = cb;
                    pixels[o + 1] = cg;
                    pixels[o + 2] = cr;
                    pixels[o + 3] = 255;
                }
            }
            using (var stream = bmp.PixelBuffer.AsStream())
                stream.Write(pixels, 0, pixels.Length);
            _sharedDisc = bmp;
            return bmp;
        }

        private static (byte, byte, byte) RimColor() => (255, 255, 255);

        private static void WritePixel(byte[] px, int o, (byte R, byte G, byte B) c, double alpha)
        {
            var a = (byte)(alpha * 0.12 * 255);        // rim is 12% white
            px[o] = (byte)(c.B * a / 255);             // premultiplied BGRA
            px[o + 1] = (byte)(c.G * a / 255);
            px[o + 2] = (byte)(c.R * a / 255);
            px[o + 3] = a;
        }

        private static (byte R, byte G, byte B) HslToRgb(double h, double s, double l)
        {
            var c = (1 - Math.Abs(2 * l - 1)) * s;
            var hp = h / 60.0;
            var x = c * (1 - Math.Abs(hp % 2 - 1));
            var (r1, g1, b1) = hp switch
            {
                < 1 => (c, x, 0.0),
                < 2 => (x, c, 0.0),
                < 3 => (0.0, c, x),
                < 4 => (0.0, x, c),
                < 5 => (x, 0.0, c),
                _ => (c, 0.0, x),
            };
            var m = l - c / 2;
            return ((byte)((r1 + m) * 255), (byte)((g1 + m) * 255), (byte)((b1 + m) * 255));
        }
    }
}
