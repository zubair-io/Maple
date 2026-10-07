using System;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services
{
    public sealed partial class RenderScheduler
    {
        private (DecodedImage Image, AdjustmentState State, FilmLut? Film)? _pendingHistogram;
        private float[]? _histogramScratch;
        private byte[]? _histogramPixels;
        private long _histogramQueuedAt;

        private void PrepareHistogramBuffersLocked()
        {
            var image = _halfImage ?? _image;
            if (!_gpuSessionOpen || image == null) return;
            // #4383: allocate these existing bounded buffers during session
            // initialization, before a first edit can trigger LOH collection.
            _histogramPixels = new byte[checked(image.Width * image.Height * 4)];
            _histogramScratch = new float[image.Pixels.Length];
        }

        public bool IsCurrentRender(DecodedImage image, AdjustmentState state)
        {
            lock (_gate) return IsCurrentFrame(image) && ReferenceEquals(state, _lastRendered) && _pending == null;
        }

        private void QueueHistogram(DecodedImage image, AdjustmentState state)
        {
            lock (_gate)
            {
                if (!IsCurrentRender(image, state)) return;
                _pendingHistogram = (image, state, _activeFilm);
                _histogramQueuedAt = System.Diagnostics.Stopwatch.GetTimestamp();
            }
        }

        private void PollHistogram()
        {
            (DecodedImage Image, AdjustmentState State, FilmLut? Film)? request;
            lock (_gate)
            {
                if (_stopping) return;
                // Give a new gesture priority over CPU histogram work. A newer
                // request clears this snapshot; quiet images still publish.
                if (System.Diagnostics.Stopwatch.GetElapsedTime(_histogramQueuedAt).TotalMilliseconds < RefineDebounceMs)
                    return;
                request = _pendingHistogram;
                _pendingHistogram = null;
            }
            if (request is { } current && IsCurrentRender(current.Image, current.State))
                EmitHistogram(current.Image, current.State, current.Film);
        }

        private void EmitHistogram(DecodedImage image, AdjustmentState state, FilmLut? film = null)
        {
            var started = System.Diagnostics.Stopwatch.GetTimestamp();
            try
            {
                var byteCount = image.Width * image.Height * 4;
                byte[] pixels;
                float[]? scratch;
                lock (_gate)
                {
                    pixels = _histogramPixels != null && _histogramPixels.Length == byteCount ? _histogramPixels : new byte[byteCount];
                    scratch = _histogramScratch;
                    _histogramPixels = null;
                    _histogramScratch = null;
                }
                // #4289: SetImage may clear caches during the native call.
                RenderEngine.RenderTick(image, state, ref scratch, pixels, film);
                _beforeHistogramPublishForSmoke?.Invoke();
                var bins = ComputeHistogram(pixels);
                lock (_gate)
                {
                    if (!IsCurrentRender(image, state)) return;
                }
                HistogramReady?.Invoke(image, state, bins);
                EmitClipSource(image, state, pixels, image.Width, image.Height);
                // Readers finish before the next tick can borrow these buffers.
                lock (_gate)
                {
                    if (!IsCurrentRender(image, state)) return;
                    _histogramPixels = pixels;
                    _histogramScratch = scratch;
                }
            }
            catch (Exception ex)
            {
                DiagLog.Write($"[histogram] {ex}");
                _histogramFailureForSmoke?.Invoke(ex);
                if (IsCurrentRender(image, state)) RenderFailed?.Invoke(ex.Message);
            }
            finally
            {
                DiagLog.Write($"[histogram] complete_ms={System.Diagnostics.Stopwatch.GetElapsedTime(started).TotalMilliseconds}");
            }
        }

        private void EmitClipSource(DecodedImage image, AdjustmentState state, byte[] pixels, int width, int height)
        {
            if (!ClipOverlayEnabled || ClipSourceReady == null)
                return;
            var copy = new byte[pixels.Length];
            Buffer.BlockCopy(pixels, 0, copy, 0, pixels.Length);
            ClipSourceReady?.Invoke(image, state, copy, width, height);
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
