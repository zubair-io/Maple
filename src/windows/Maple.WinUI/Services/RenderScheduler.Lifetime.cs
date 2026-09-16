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
        internal bool HasPendingPresent => Volatile.Read(ref _presentPending) != 0;
        internal event Action? PresentQueued;
        internal int DroppedClosingPresents { get; private set; }

        private int DispatchPresent(Microsoft.UI.Dispatching.DispatcherQueue queue, DecodedImage image,
            AdjustmentState state, IntPtr panel, ulong generation, bool useHalf, int width, int height)
        {
            var completion = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
            Volatile.Write(ref _presentPending, 1);
            if (!queue.TryEnqueue(() =>
            {
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
                    completion.TrySetResult(GpuPresentOnUiThread(image, state, panel, generation, useHalf, width, height));
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
            try { await _loopTask; }
            finally
            {
                lock (_gate)
                {
                    CloseGpuSessionLocked();
                    _panelNative = IntPtr.Zero;
                    _image = _halfImage = null;
                    _pending = _lastRendered = null;
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
