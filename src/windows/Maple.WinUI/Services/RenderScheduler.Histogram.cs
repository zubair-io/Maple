using System;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services
{
    public sealed partial class RenderScheduler
    {
        private void EmitHistogram(DecodedImage image, AdjustmentState state)
        {
            try
            {
                var byteCount = image.Width * image.Height * 4;
                byte[] pixels;
                float[]? scratch;
                lock (_gate)
                {
                    pixels = _bgra != null && _bgra.Length == byteCount ? _bgra : new byte[byteCount];
                    scratch = _chainScratch;
                    _bgra = null;
                    _chainScratch = null;
                }
                // #4289: SetImage may clear caches during the native call.
                RenderEngine.RenderTick(image, state, ref scratch, pixels, _activeFilm);
                _beforeHistogramPublishForSmoke?.Invoke();
                lock (_gate)
                {
                    if (!IsCurrentFrame(image)) return;
                }
                HistogramReady?.Invoke(ComputeHistogram(pixels));
                EmitClipSource(pixels, image.Width, image.Height);
                // Readers finish before the next tick can borrow these buffers.
                lock (_gate)
                {
                    if (!IsCurrentFrame(image)) return;
                    _bgra = pixels;
                    _chainScratch = scratch;
                }
            }
            catch (Exception ex)
            {
                DiagLog.Write($"[histogram] {ex}");
                _histogramFailureForSmoke?.Invoke(ex);
                if (IsCurrentFrame(image)) RenderFailed?.Invoke(ex.Message);
            }
        }

        private void EmitClipSource(byte[] pixels, int width, int height)
        {
            if (!ClipOverlayEnabled || ClipSourceReady == null)
                return;
            var copy = new byte[pixels.Length];
            Buffer.BlockCopy(pixels, 0, copy, 0, pixels.Length);
            ClipSourceReady?.Invoke(copy, width, height);
        }

        private static uint[] ComputeHistogram(byte[] bgra)
        {
            // [0..767] R/G/B (HistogramView), [768..1023] Rec.709 luma — the
            // tone-curve plot's backdrop (#2576), truncated-int per pixel like
            // the web's computeRgbHistograms.
            var bins = new uint[1024];
            for (var i = 0; i < bgra.Length; i += 4)
            {
                var r = bgra[i + 2];
                var g = bgra[i + 1];
                var b = bgra[i];
                bins[r]++;
                bins[256 + g]++;
                bins[512 + b]++;
                bins[768 + (int)(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
            }
            return bins;
        }

    }
}
