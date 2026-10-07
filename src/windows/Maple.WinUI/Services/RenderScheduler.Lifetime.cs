using System;
using System.Threading.Tasks;
using System.Threading;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services
{
    public sealed partial class RenderScheduler
    {
        private readonly Task _loopTask;
        private bool _stopping;
        private Task? _stopTask;
        private int _presentPending;
        private double _lastPresentQueueMillis, _lastUiPresentMillis;
        internal bool HasPendingPresent => Volatile.Read(ref _presentPending) != 0;
        internal event Action? PresentQueued;
        internal int DroppedClosingPresents { get; private set; }

        private int DispatchPresent(Microsoft.UI.Dispatching.DispatcherQueue queue, DecodedImage image,
            AdjustmentState state, IntPtr panel, ulong generation, bool useHalf, int width, int height, bool sampleScopes)
        {
            var completion = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
            var queuedAt = System.Diagnostics.Stopwatch.GetTimestamp();
            Volatile.Write(ref _presentPending, 1);
            if (!queue.TryEnqueue(() =>
            {
                var enteredAt = System.Diagnostics.Stopwatch.GetTimestamp();
                _lastPresentQueueMillis = System.Diagnostics.Stopwatch.GetElapsedTime(queuedAt, enteredAt).TotalMilliseconds;
                Volatile.Write(ref _presentPending, 0);
                try
                {
                    lock (_gate)
                    {
                        if (_stopping)
                        {
                            DroppedClosingPresents++;
                            completion.TrySetResult(int.MinValue);
                            return;
                        }
                    }
                    var rc = GpuPresentOnUiThread(image, state, panel, generation, useHalf, width, height, sampleScopes);
                    _lastUiPresentMillis = System.Diagnostics.Stopwatch.GetElapsedTime(enteredAt).TotalMilliseconds;
                    completion.TrySetResult(rc);
                }
                catch (Exception error) { completion.TrySetException(error); }
            }))
            {
                Volatile.Write(ref _presentPending, 0);
                return -1;
            }
            PresentQueued?.Invoke();
            try { return completion.Task.GetAwaiter().GetResult(); }
            finally { Volatile.Write(ref _presentPending, 0); }
        }

        // #4383: distinguish dispatcher starvation from UI preparation/native
        // work and render-thread wakeup; retain the original total tick metric.
        private string PresentTiming(bool useHalf, double total) =>
            $"[tick] {(useHalf ? "half" : "full")} total={total}ms ffi={_lastFfiMillis}ms " +
            $"queue_ms={_lastPresentQueueMillis} ui_ms={_lastUiPresentMillis} " +
            $"completion_ms={total - _lastPresentQueueMillis - _lastUiPresentMillis}";


        // Called on the owning UI context. Never synchronously join here:
        // GpuPresent can be waiting for that same dispatcher's callback.
        public Task StopAsync()
        {
            lock (_gate)
            {
                if (_stopTask != null) return _stopTask;
                _stopping = true;
                _cts.Cancel();
                return _stopTask = FinishStopAsync();
            }
        }

        private async Task FinishStopAsync()
        {
            try { await Task.WhenAll(_loopTask, _scopeLoopTask); }
            finally
            {
                lock (_gate)
                {
                    CloseGpuSessionLocked();
                    _panelNative = IntPtr.Zero;
                    _image = _halfImage = null;
                    _pending = _lastRendered = null;
                    _pendingHistogram = null;
                    _histogramPixels = null;
                    _histogramScratch = null;
                }
                DiagLog.Write("[lifetime] render loop joined; native sessions closed");
            }
        }

        internal bool IsStopped
        {
            get { lock (_gate) return _stopTask?.IsCompleted == true &&
                !_gpuSessionOpen && !_gpuSessionHalfOpen && _panelNative == IntPtr.Zero; }
        }

        public void Dispose() => _ = StopAsync();
    }
}
