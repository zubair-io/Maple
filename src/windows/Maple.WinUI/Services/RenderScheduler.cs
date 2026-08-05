using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services
{
    /// <summary>
    /// Latest-wins background render loop. Slider ticks overwrite the pending
    /// snapshot; the loop always renders the newest state and drops stale
    /// requests, so a fast slider drag never queues more than one frame.
    ///
    /// Two display paths (#2561):
    /// - GPU: the wgpu DX12 live chain presents straight into the WinUI
    ///   SwapChainPanel (maple_gpu_present_chain_winui) at full session
    ///   resolution on every tick; a half-res CPU tick runs only after the
    ///   drag settles, solely to feed the histogram.
    /// - CPU fallback: the fused CPU chain renders BGRA frames (half-res fast
    ///   pass, debounced full-res refine). Any GPU failure downgrades to this
    ///   path for the rest of the process.
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

        private IntPtr _panelNative;
        private ulong _surfaceGeneration = 1;
        private MapleGpuLiveSession _gpuSession;
        private bool _gpuSessionOpen;
        private bool _gpuDisabled;
        private DecodedImage? _gpuImage;

        /// <summary>CPU-path frame: (bgra, width, height, histogram bins,
        /// renderMillis). Raised on the render thread.</summary>
        public event Action<byte[], int, int, uint[], double>? FrameReady;
        /// <summary>GPU-path present completed: (width, height, presentMillis).
        /// The pixels are already on screen in the SwapChainPanel.</summary>
        public event Action<int, int, double>? GpuFrameReady;
        /// <summary>Histogram bins for the newest state (GPU path only — the
        /// CPU path carries bins on FrameReady).</summary>
        public event Action<uint[]>? HistogramReady;
        public event Action<string>? RenderFailed;
        /// <summary>Raised once if the GPU path fails and the session downgrades
        /// to the CPU fallback.</summary>
        public event Action<string>? GpuUnavailable;

        public RenderScheduler()
        {
            _ = Task.Run(LoopAsync);
        }

        /// <summary>The QI'd ISwapChainPanelNative* for the canvas panel. Set
        /// once at startup, before any image opens; the panel must outlive the
        /// scheduler.</summary>
        public void SetPresentTarget(IntPtr panelNative)
        {
            // Diagnostic escape hatch: MAPLE_FORCE_CPU=1 keeps the CPU fallback
            // active so GPU-vs-CPU output can be A/B'd on screen.
            if (Environment.GetEnvironmentVariable("MAPLE_FORCE_CPU") == "1")
            {
                DiagLog.Write("[gpu] disabled by MAPLE_FORCE_CPU");
                return;
            }
            lock (_gate)
            {
                _panelNative = panelNative;
            }
        }

        /// <summary>Bump when the panel's composition scale changes or the panel
        /// is re-created — forces a fresh swapchain configure on next present.</summary>
        public void BumpSurfaceGeneration()
        {
            lock (_gate)
            {
                _surfaceGeneration++;
            }
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
                CloseGpuSessionLocked();
                if (image != null)
                    DiagLog.Write($"[gpu] SetImage: panel={_panelNative != IntPtr.Zero} disabled={_gpuDisabled}");
                if (image != null && _panelNative != IntPtr.Zero && !_gpuDisabled)
                    OpenGpuSessionLocked(image);
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

        private unsafe void OpenGpuSessionLocked(DecodedImage image)
        {
            fixed (float* px = image.Pixels)
            fixed (MapleGpuLiveSession* handle = &_gpuSession)
            {
                var rc = RawFfi.maple_gpu_live_open(
                    px, (uint)image.Width, (uint)image.Height, handle);
                if (rc != 0)
                {
                    DisableGpuLocked($"gpu_live_open rc={rc}: {RawFfi.LastError()}");
                    return;
                }
            }
            _gpuSessionOpen = true;
            _gpuImage = image;
            DiagLog.Write($"[gpu] live session open {image.Width}x{image.Height}");
        }

        private unsafe void CloseGpuSessionLocked()
        {
            if (!_gpuSessionOpen)
                return;
            fixed (MapleGpuLiveSession* handle = &_gpuSession)
            {
                RawFfi.maple_gpu_live_close(handle);
            }
            _gpuSession.inner = IntPtr.Zero;
            _gpuSessionOpen = false;
            _gpuImage = null;
        }

        private void DisableGpuLocked(string reason)
        {
            CloseGpuSessionLocked();
            if (_gpuDisabled)
                return;
            _gpuDisabled = true;
            DiagLog.Write($"[gpu] disabled: {reason}");
            GpuUnavailable?.Invoke(reason);
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

                // Fast pass: newest state — GPU present at full session res, or
                // the half-res CPU frame on the fallback path.
                var rendered = RenderOnce(fastPass: true);

                // Settle pass once the slider has been quiet for the debounce
                // window: CPU full-res refine (fallback path) or the
                // histogram-only half-res tick (GPU path).
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
                        RenderOnce(fastPass: true);
                        continue;
                    }
                    RenderOnce(fastPass: false);
                    break;
                }
            }
        }

        private bool RenderOnce(bool fastPass)
        {
            DecodedImage? image;
            DecodedImage? halfImage;
            AdjustmentState? state;
            bool gpuActive;
            IntPtr panel;
            ulong generation;
            lock (_gate)
            {
                image = _image;
                halfImage = _halfImage;
                state = _pending ?? (fastPass ? null : _lastRendered);
                _pending = null;
                if (state != null)
                    _lastRendered = state;
                gpuActive = _gpuSessionOpen && ReferenceEquals(_gpuImage, _image);
                panel = _panelNative;
                generation = _surfaceGeneration;
            }
            if (image == null || state == null)
                return false;

            if (gpuActive)
            {
                if (fastPass)
                    return GpuPresent(image, state, panel, generation);
                EmitHistogram(halfImage ?? image, state);
                return true;
            }

            var target = fastPass ? halfImage ?? image : image;
            return CpuRender(target, state, emitFrame: true);
        }

        private bool GpuPresent(
            DecodedImage image, AdjustmentState state, IntPtr panel, ulong generation)
        {
            // The present must run on the UI thread: the first configure calls
            // ISwapChainPanelNative::SetSwapChain, which rejects background
            // threads ("Invalid surface" from Surface::configure). The chain
            // itself executes on the GPU; the UI thread only pays command
            // encoding + submit.
            var queue = App.MainDispatcherQueue;
            if (queue == null)
            {
                lock (_gate)
                {
                    DisableGpuLocked("no UI dispatcher for SwapChainPanel present");
                }
                return CpuRender(_halfImage ?? image, state, emitFrame: true);
            }

            var started = Environment.TickCount64;
            var completion = new TaskCompletionSource<int>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            if (!queue.TryEnqueue(() => completion.TrySetResult(
                    GpuPresentOnUiThread(image, state, panel, generation))))
            {
                lock (_gate)
                {
                    DisableGpuLocked("dispatcher enqueue failed");
                }
                return CpuRender(_halfImage ?? image, state, emitFrame: true);
            }
            var rc = completion.Task.GetAwaiter().GetResult();
            if (rc == int.MinValue)
                return true;  // superseded by a newer SetImage — dropped
            if (rc == 0)
            {
                GpuFrameReady?.Invoke(
                    image.Width, image.Height, Environment.TickCount64 - started);
                return true;
            }

            // Any failure (other than the cancel code, which we never request
            // with a null flag) downgrades to the CPU path — same contract as
            // the other shells. The error message was captured on the UI thread
            // (maple_last_error is thread-local).
            lock (_gate)
            {
                DisableGpuLocked($"present rc={rc}: {_lastGpuError ?? "unknown"}");
            }
            return CpuRender(_halfImage ?? image, state, emitFrame: true);
        }

        private string? _lastGpuError;

        /// <summary>Runs on the UI thread. Returns the FFI rc, or int.MinValue
        /// when the session was superseded before the call.</summary>
        private unsafe int GpuPresentOnUiThread(
            DecodedImage image, AdjustmentState state, IntPtr panel, ulong generation)
        {
            var p = MapleGpuLiveParams.From(state, image);
            // The whole FFI call runs under the gate: SetImage (decode thread)
            // frees the session handle via maple_gpu_live_close, and a present
            // against a freed handle box is use-after-free. The native side's
            // own GPU_SHARED mutex serializes GPU work, not handle lifetime.
            lock (_gate)
            {
                if (!_gpuSessionOpen || !ReferenceEquals(_gpuImage, image))
                    return int.MinValue;
                int rc;
                fixed (float* noisePtr = image.NoiseProfile)
                fixed (float* curvePtr = image.ProfileCurve)
                fixed (float* residualPtr = image.ResidualLut)
                fixed (MapleGpuLiveSession* handle = &_gpuSession)
                {
                    if (image.NoiseProfile.Length > 0)
                    {
                        p.noise_profile_ptr = noisePtr;
                        p.noise_profile_len = (uint)image.NoiseProfile.Length;
                    }
                    // Auto Profile tail (#550/#924): fitted curve + residual LUT
                    // — without these a Profile::Auto decode renders ΔE00 ≈ 19
                    // off the embedded-JPEG look (measured on the CR2 set).
                    if (image.ProfileCurve is { Length: > 0 })
                    {
                        p.profile_curve_ptr = curvePtr;
                        p.profile_curve_len = (nuint)image.ProfileCurve.Length;
                    }
                    if (image.ResidualLut is { Length: > 0 })
                    {
                        p.residual_lut_ptr = residualPtr;
                        p.residual_lut_len = (nuint)image.ResidualLut.Length;
                        p.residual_lut_size = image.ResidualLutSize;
                    }
                    rc = RawFfi.maple_gpu_present_chain_winui(
                        handle, &p, panel, IntPtr.Zero, generation);
                }
                _lastGpuError = rc == 0 ? null : RawFfi.LastError();
                return rc;
            }
        }

        private bool CpuRender(DecodedImage image, AdjustmentState state, bool emitFrame)
        {
            try
            {
                var byteCount = image.Width * image.Height * 4;
                if (_bgra == null || _bgra.Length != byteCount)
                    _bgra = new byte[byteCount];

                var started = Environment.TickCount64;
                RenderEngine.RenderTick(image, state, ref _chainScratch, _bgra);
                var elapsed = (double)(Environment.TickCount64 - started);

                if (emitFrame)
                    FrameReady?.Invoke(_bgra, image.Width, image.Height,
                        ComputeHistogram(_bgra), elapsed);
                DumpFrameIfRequested(_bgra, image.Width, image.Height);
                return true;
            }
            catch (Exception ex)
            {
                RenderFailed?.Invoke(ex.Message);
                return false;
            }
        }

        private void EmitHistogram(DecodedImage image, AdjustmentState state)
        {
            try
            {
                var byteCount = image.Width * image.Height * 4;
                if (_bgra == null || _bgra.Length != byteCount)
                    _bgra = new byte[byteCount];
                RenderEngine.RenderTick(image, state, ref _chainScratch, _bgra);
                HistogramReady?.Invoke(ComputeHistogram(_bgra));
            }
            catch (Exception ex)
            {
                RenderFailed?.Invoke(ex.Message);
            }
        }

        /// <summary>Diagnostic: MAPLE_DUMP_FRAME=&lt;path.png&gt; writes the next
        /// CPU-rendered frame to disk — pixel-exact app output for the color
        /// parity harness, independent of screenshots/DWM.</summary>
        private static void DumpFrameIfRequested(byte[] bgra, int width, int height)
        {
            var path = Environment.GetEnvironmentVariable("MAPLE_DUMP_FRAME");
            if (string.IsNullOrEmpty(path) || File.Exists(path))
                return;
            try
            {
                using var bitmap = new System.Drawing.Bitmap(
                    width, height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                var data = bitmap.LockBits(
                    new System.Drawing.Rectangle(0, 0, width, height),
                    System.Drawing.Imaging.ImageLockMode.WriteOnly,
                    System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                System.Runtime.InteropServices.Marshal.Copy(bgra, 0, data.Scan0, bgra.Length);
                bitmap.UnlockBits(data);
                bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png);
                DiagLog.Write($"[dump] frame {width}x{height} -> {path}");
            }
            catch (Exception ex)
            {
                DiagLog.Write($"[dump] failed: {ex.Message}");
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
            lock (_gate)
            {
                CloseGpuSessionLocked();
            }
        }
    }
}
