using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    /// <summary>
    /// Headless-ish qualification mode (#2587) — the Windows counterpart of
    /// the Apple UITest visual harness, driven by environment variables so
    /// src/windows/scripts/qualify-winui.ps1 can run it unattended:
    ///
    ///   MAPLE_QUALIFY_RAW=&lt;raw path&gt;   photo to open in Edit
    ///   MAPLE_QUALIFY_OUT=&lt;dir&gt;        where report.json lands
    ///
    /// The run decodes, then times TICKS wiggling Exposure ±0.01 through the
    /// real render loop (GPU presents, or CPU ticks under MAPLE_FORCE_CPU=1;
    /// combine the CPU run with MAPLE_DUMP_FRAME for the pixel-exact parity
    /// frame), writes the timing report, and exits.
    /// </summary>
    public sealed partial class MainWindow
    {
        private const int QualifyTicks = 20;

        private void MaybeStartQualifyRun()
        {
            var raw = Environment.GetEnvironmentVariable("MAPLE_QUALIFY_RAW");
            var outDir = Environment.GetEnvironmentVariable("MAPLE_QUALIFY_OUT");
            if (string.IsNullOrEmpty(raw) || string.IsNullOrEmpty(outDir))
                return;
            _ = RunQualifyAsync(raw!, outDir!);
        }

        private async Task RunQualifyAsync(string rawPath, string outDir)
        {
            var exitCode = 0;
            try
            {
                Directory.CreateDirectory(outDir);
                var ticks = new List<double>();
                var path = "gpu";
                var tickWaiter = new TaskCompletionSource<double>(
                    TaskCreationOptions.RunContinuationsAsynchronously);
                ViewModel.Renderer.GpuFrameReady += (_, _, ms) =>
                    tickWaiter.TrySetResult(ms);
                ViewModel.Renderer.FrameReady += (_, _, _, _, ms) =>
                {
                    path = "cpu";
                    tickWaiter.TrySetResult(ms);
                };

                var photo = new PhotoItem
                {
                    FilePath = rawPath,
                    FileName = Path.GetFileName(rawPath),
                    Format = Path.GetExtension(rawPath).TrimStart('.').ToUpperInvariant(),
                };
                var decodeStarted = Environment.TickCount64;
                SetMode(ShellMode.Edit);
                ViewModel.SelectedPhoto = photo;
                ViewModel.EnsureDecoded();

                // First frame = decode + first render complete.
                await tickWaiter.Task;
                var decodeMs = Environment.TickCount64 - decodeStarted;

                for (var i = 0; i < QualifyTicks; i++)
                {
                    tickWaiter = new TaskCompletionSource<double>(
                        TaskCreationOptions.RunContinuationsAsynchronously);
                    ViewModel.Adjustments.Exposure += i % 2 == 0 ? 0.01 : -0.01;
                    ViewModel.NotifyAdjustmentEdited();
                    ticks.Add(await tickWaiter.Task);
                }

                var sorted = ticks.OrderBy(v => v).ToList();
                var report = new
                {
                    raw = rawPath,
                    render_path = path,
                    decode_ms = decodeMs,
                    tick_ms = ticks,
                    median_ms = sorted[sorted.Count / 2],
                    p95_ms = sorted[(int)Math.Min(sorted.Count - 1, Math.Ceiling(sorted.Count * 0.95) - 1)],
                    target_ms = 16.0,
                    hard_limit_ms = 50.0,
                };
                await File.WriteAllTextAsync(
                    Path.Combine(outDir, "report.json"),
                    JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));

                // Give the histogram quiet-tick (and MAPLE_DUMP_FRAME on the
                // CPU run) time to land before exiting.
                await Task.Delay(1500);
            }
            catch (Exception ex)
            {
                exitCode = 1;   // the harness must see failure as failure
                Services.DiagLog.Write($"[qualify] failed: {ex.Message}");
                try
                {
                    await File.WriteAllTextAsync(
                        Path.Combine(outDir, "report.json"),
                        JsonSerializer.Serialize(new { error = ex.Message }));
                }
                catch (IOException) { /* report is best-effort on failure */ }
            }
            finally
            {
                // Hard exit: Application.Exit() trips over XAML teardown in
                // WinUI 3 desktop apps and can leave the process alive; the
                // report is already flushed and nothing here needs disposal.
                Environment.Exit(exitCode);
            }
        }
    }
}
