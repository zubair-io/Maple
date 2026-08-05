using System;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services
{
    /// <summary>
    /// Latest-wins background render loop. Slider ticks overwrite the pending
    /// snapshot; the loop always renders the newest state and drops stale
    /// requests, so a fast slider drag never queues more than one frame.
    /// </summary>
    public sealed class RenderScheduler : IDisposable
    {
        private const int RefineDebounceMs = 150;

        private readonly SemaphoreSlim _signal = new(0, 1);
        private readonly CancellationTokenSource _cts = new();
        private readonly object _gate = new();
        private DecodedImage? _image;
        private DecodedImage? _halfImage;
        private AdjustmentState? _pending;
        private AdjustmentState? _lastRendered;
        private float[]? _chainScratch;
        private byte[]? _bgra;

        /// <summary>Fired on the render thread with (bgra, width, height,
        /// histogramBins[768 channel-major R/G/B], renderMillis).</summary>
        public event Action<byte[], int, int, uint[], double>? FrameReady;
        public event Action<string>? RenderFailed;

        public RenderScheduler()
        {
            _ = Task.Run(LoopAsync);
        }

        public void SetImage(DecodedImage? image)
        {
            var half = image == null ? null : RenderEngine.DownsampleHalf(image);
            lock (_gate)
            {
                _image = image;
                _halfImage = half;
                _lastRendered = null;
                _chainScratch = null;
                _bgra = null;
            }
        }

        public void RequestRender(AdjustmentState snapshot)
        {
            lock (_gate)
            {
                _pending = snapshot;
            }
            try { _signal.Release(); } catch (SemaphoreFullException) { }
        }

        private async Task LoopAsync()
        {
            while (!_cts.IsCancellationRequested)
            {
                try
                {
                    await _signal.WaitAsync(_cts.Token);
                }
                catch (OperationCanceledException)
                {
                    return;
                }

                // Fast pass: newest state at half resolution.
                var rendered = RenderOnce(useHalf: true);

                // Refine pass: full preview resolution once the slider has been
                // quiet for the debounce window; a new request cancels it.
                while (rendered && !_cts.IsCancellationRequested)
                {
                    bool newRequest;
                    try
                    {
                        newRequest = await _signal.WaitAsync(RefineDebounceMs, _cts.Token);
                    }
                    catch (OperationCanceledException)
                    {
                        return;
                    }
                    if (newRequest)
                    {
                        RenderOnce(useHalf: true);
                        continue;
                    }
                    RenderOnce(useHalf: false);
                    break;
                }
            }
        }

        /// <summary>Renders the newest pending state (or re-renders the last
        /// state for a refine pass). Returns false when there is nothing to do.</summary>
        private bool RenderOnce(bool useHalf)
        {
            DecodedImage? image;
            AdjustmentState? state;
            lock (_gate)
            {
                image = useHalf ? _halfImage ?? _image : _image;
                state = _pending ?? (useHalf ? null : _lastRendered);
                _pending = null;
                if (state != null)
                    _lastRendered = state;
            }
            if (image == null || state == null)
                return false;

            try
            {
                var byteCount = image.Width * image.Height * 4;
                if (_bgra == null || _bgra.Length != byteCount)
                    _bgra = new byte[byteCount];

                var started = Environment.TickCount64;
                RenderEngine.RenderTick(image, state, ref _chainScratch, _bgra);
                var elapsed = (double)(Environment.TickCount64 - started);

                FrameReady?.Invoke(_bgra, image.Width, image.Height,
                    ComputeHistogram(_bgra), elapsed);
                return true;
            }
            catch (Exception ex)
            {
                RenderFailed?.Invoke(ex.Message);
                return false;
            }
        }

        private static uint[] ComputeHistogram(byte[] bgra)
        {
            var bins = new uint[768];
            for (var i = 0; i < bgra.Length; i += 4)
            {
                bins[bgra[i + 2]]++;          // R
                bins[256 + bgra[i + 1]]++;    // G
                bins[512 + bgra[i]]++;        // B
            }
            return bins;
        }

        public void Dispose()
        {
            _cts.Cancel();
            try { _signal.Release(); } catch (SemaphoreFullException) { }
        }
    }
}
