using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        private bool _lifecycleSmokeActive;

        // Explicit diagnostic invocation only; no runtime setting or new env flag.
        internal void MaybeStartLifecycleSmoke()
        {
            var args = Environment.GetCommandLineArgs();
            var index = Array.IndexOf(args, "--lifecycle-smoke");
            if (index < 0) return;
            if (args.Length != index + 4) throw new ArgumentException("--lifecycle-smoke RAW OUT gpu|cpu|empty");
            _ = RunLifecycleSmokeAsync(args[index + 1], args[index + 2], args[index + 3]);
        }

        private async Task RunLifecycleSmokeAsync(string raw, string output, string expectedPath)
        {
            _lifecycleSmokeActive = true;
            Directory.CreateDirectory(output);
            var reportPath = Path.Combine(output, "lifecycle.json");
            try
            {
                var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
                if (hwnd == IntPtr.Zero || _panelNative == IntPtr.Zero)
                    throw new InvalidOperationException("Real HWND and QI'd panel required");
                var panel = _panelNative;
                // A scheduler disposed before receiving a native target/image
                // exercises partial initialization with its real loop.
                var unattached = new RenderScheduler();
                await unattached.StopAsync();
                await unattached.StopAsync();
                if (!unattached.IsStopped) throw new InvalidOperationException("Unattached scheduler did not stop");
                var renderer = ViewModel.Renderer;
                var frame = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
                void Gpu(int w, int h, double ms, bool full) => frame.TrySetResult("gpu");
                void Cpu(byte[] px, int w, int h, uint[] bins, double ms) => frame.TrySetResult("cpu");
                renderer.GpuFrameReady += Gpu;
                renderer.FrameReady += Cpu;
                var actualPath = "empty";
                if (expectedPath != "empty")
                {
                    SetMode(ShellMode.Edit);
                    ViewModel.SelectedPhoto = new PhotoItem
                    {
                        FilePath = raw, FileName = Path.GetFileName(raw), Format = "DNG"
                    };
                    ViewModel.EnsureDecoded();
                    actualPath = await frame.Task.WaitAsync(TimeSpan.FromSeconds(90));
                    if (actualPath != expectedPath)
                        throw new InvalidOperationException($"Required {expectedPath} frame, got {actualPath}");
                }
                renderer.GpuFrameReady -= Gpu;
                renderer.FrameReady -= Cpu;

                // Real queued UI present, held solely by this smoke's UI turn.
                // The production close path must pump it while awaiting the loop.
                using var queued = new ManualResetEventSlim();
                void Queued() => queued.Set();
                if (expectedPath == "gpu")
                {
                    renderer.PresentQueued += Queued;
                    renderer.RequestRender(ViewModel.Adjustments.Clone());
                    if (!queued.Wait(TimeSpan.FromSeconds(5)))
                        throw new TimeoutException("No real GPU present queued before close");
                    renderer.PresentQueued -= Queued;
                }
                Close();
                Close(); // repeated request before the dispatcher starts its drain
                // Close schedules the drain after returning from WinUI's callback.
                await Task.Yield();
                await ShutdownAsync();
                await ShutdownAsync();
                if (!renderer.IsStopped || _panelNative != IntPtr.Zero || _panelReleaseCount != 1)
                    throw new InvalidOperationException("Shutdown did not join/close/release exactly once");
                if (expectedPath == "gpu" && renderer.DroppedClosingPresents == 0)
                    throw new InvalidOperationException("Queued present was not drained during close");
                // Exercise a real late decoded result, after close has started.
                var late = await Task.Run(() => RenderEngine.Decode(raw, new AdjustmentState(), 256, RefineDecodeQuality.Preview, IntPtr.Zero));
                renderer.SetImage(late);
                renderer.SetPresentTarget(panel); // stale late attachment must be rejected
                renderer.RequestRender(new AdjustmentState());
                if (!renderer.IsStopped) throw new InvalidOperationException("Late producer reopened renderer");
                File.WriteAllText(reportPath, JsonSerializer.Serialize(new
                {
                    passed = true, hwnd = hwnd.ToInt64(), renderPath = actualPath,
                    panelReleases = _panelReleaseCount, rendererStopped = renderer.IsStopped,
                    droppedClosingPresents = renderer.DroppedClosingPresents
                }));
            }
            catch (Exception error)
            {
                Environment.ExitCode = 1;
                File.WriteAllText(reportPath, JsonSerializer.Serialize(new { passed = false, error = error.ToString() }));
            }
            finally
            {
                await ShutdownAsync();
                _closeReady = true;
                Close(); // normal WinUI teardown; never Environment.Exit
            }
        }
    }
}
