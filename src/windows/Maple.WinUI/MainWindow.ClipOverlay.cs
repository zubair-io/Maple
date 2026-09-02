using System;
using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media.Imaging;

namespace Maple.WinUI
{
    /// <summary>Shadow/highlight clipping overlay (#2574): the two toolbar
    /// toggles, the indicator dots driven off the live histogram, and the
    /// per-frame BGRA paint that turns blown highlights red and crushed
    /// shadows blue over the clip-source frame the renderer publishes.</summary>
    public sealed partial class MainWindow
    {
        // --- Clipping overlay (#2574) ---

        private bool _clipShadowOn;
        private bool _clipHighlightOn;
        private WriteableBitmap? _clipOverlayBitmap;
        private byte[]? _clipOverlayScratch;   // reused per frame — no per-tick allocation

        private void OnToggleShadowClip(object sender, RoutedEventArgs e)
        {
            _clipShadowOn = !_clipShadowOn;
            ApplyClipToggles();
        }

        private void OnToggleHighlightClip(object sender, RoutedEventArgs e)
        {
            _clipHighlightOn = !_clipHighlightOn;
            ApplyClipToggles();
        }

        private void ApplyClipToggles()
        {
            ViewModel.Renderer.ClipOverlayEnabled = _clipShadowOn || _clipHighlightOn;
            if (!ViewModel.Renderer.ClipOverlayEnabled)
                ClipOverlayImage.Visibility = Visibility.Collapsed;
            UpdateClipIndicators();
            // Kick one tick so the overlay (dis)appears without waiting for
            // the next slider edit.
            ViewModel.Renderer.RequestRender(ViewModel.Adjustments.Clone());
        }

        /// <summary>Indicator dots: lit in the clip color once a channel clips
        /// more than 0.1% of pixels (a lone specular pixel shouldn't glow);
        /// brighter when its overlay toggle is armed.</summary>
        private void UpdateClipIndicators()
        {
            if (_lastHistogramBins is not { Length: >= 768 } bins)
                return;
            long total = 0;
            for (var i = 0; i < 256; i++)
                total += bins[i];
            var threshold = (uint)Math.Max(1, total / 1000);
            // Same 254/1 tolerance band as the overlay: AgX's shoulder plus
            // the display dither rarely land on exactly 255/0.
            var shadowClips = ClipBandCount(bins, 0) > threshold;
            var highlightClips = ClipBandCount(bins, 254) > threshold;
            var muted = (Microsoft.UI.Xaml.Media.SolidColorBrush)
                Application.Current.Resources["MapleBorderHi"];
            var armed = new Microsoft.UI.Xaml.Media.SolidColorBrush(
                Windows.UI.Color.FromArgb(255, 0xF2, 0xEF, 0xE9));
            ShadowClipDot.Fill = shadowClips
                ? new Microsoft.UI.Xaml.Media.SolidColorBrush(
                    Windows.UI.Color.FromArgb(255, 0x4F, 0x7F, 0xC4))
                : muted;
            HighlightClipDot.Fill = highlightClips
                ? new Microsoft.UI.Xaml.Media.SolidColorBrush(
                    Windows.UI.Color.FromArgb(255, 0xD1, 0x58, 0x4A))
                : muted;
            // The armed overlay toggle reads as a ring around the dot.
            ShadowClipDot.Stroke = _clipShadowOn ? armed : null;
            ShadowClipDot.StrokeThickness = 1;
            HighlightClipDot.Stroke = _clipHighlightOn ? armed : null;
            HighlightClipDot.StrokeThickness = 1;
        }

        /// <summary>Pixels in the two-bin clip band starting at binStart, summed
        /// over R/G/B (bins are channel-major, 256 per channel).</summary>
        private static uint ClipBandCount(uint[] bins, int binStart)
        {
            uint count = 0;
            for (var channel = 0; channel < 3; channel++)
                for (var offset = 0; offset < 2; offset++)
                    count += bins[channel * 256 + binStart + offset];
            return count;
        }

        /// <summary>Paint the overlay: opaque red where any channel is blown
        /// (255), opaque blue where all three are crushed (0), transparent
        /// elsewhere — the Lightroom-style J-overlay semantics.</summary>
        private void OnClipSourceReady(byte[] bgra, int width, int height)
        {
            App.MainDispatcherQueue?.TryEnqueue(() =>
            {
                if (!ViewModel.Renderer.ClipOverlayEnabled)
                    return;
                if (_clipOverlayBitmap == null || _clipOverlayBitmap.PixelWidth != width
                    || _clipOverlayBitmap.PixelHeight != height)
                {
                    _clipOverlayBitmap = new WriteableBitmap(width, height);
                    ClipOverlayImage.Source = _clipOverlayBitmap;
                }
                if (_clipOverlayScratch == null || _clipOverlayScratch.Length != bgra.Length)
                    _clipOverlayScratch = new byte[bgra.Length];
                var overlay = _clipOverlayScratch;
                Array.Clear(overlay);
                for (var i = 0; i < bgra.Length; i += 4)
                {
                    var b = bgra[i];
                    var g = bgra[i + 1];
                    var r = bgra[i + 2];
                    if (_clipHighlightOn && (r >= 254 || g >= 254 || b >= 254))
                    {
                        overlay[i + 2] = 0xD1;    // red, premultiplied BGRA
                        overlay[i + 1] = 0x58;
                        overlay[i] = 0x4A;
                        overlay[i + 3] = 0xFF;
                    }
                    else if (_clipShadowOn && r <= 1 && g <= 1 && b <= 1)
                    {
                        overlay[i + 2] = 0x4F;    // blue
                        overlay[i + 1] = 0x7F;
                        overlay[i] = 0xC4;
                        overlay[i + 3] = 0xFF;
                    }
                }
                using (var stream = _clipOverlayBitmap.PixelBuffer.AsStream())
                {
                    stream.Write(overlay, 0, overlay.Length);
                }
                _clipOverlayBitmap.Invalidate();
                ClipOverlayImage.Visibility = Visibility.Visible;
            });
        }
    }
}
